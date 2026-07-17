import {
  BSBService,
  type BSBServiceConstructor,
  type Observable,
  bsb,
  optional,
  createConfigSchema,
  createEventSchemas,
  createFireAndForgetEvent
} from "@bsb/base";
import * as av from "anyvali";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { H3, getRequestURL, toNodeHandler } from "h3";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import TunnelClientApiClient from "../../.bsb/clients/service-tunnels-client.js";
import { buildProxyResponse, buildStreamingProxyResponse, forwardedHeaders, proxyClientIp, tunnelUnavailable, verificationFailureResponse } from "./http.js";
import { createVerificationFlow, hash, type VerificationFlow } from "./verification.js";
import { prisma } from "../../prisma.js";
import { initializePrisma } from "../../prisma.js";

export const Config = createConfigSchema(
  {
    name: "service-tunnels-proxy",
    description: "Front-facing H3 tunnel service",
    tags: ["service", "h3", "tunnel"]
  },
  av.object({
    database: av.object({
      connectionString: av.string().minLength(1).describe("PostgreSQL connection string")
    }).describe("Database configuration"),
    port: av.number().default(8080).describe("Public web listener port"),
    domain: av.string().default("tunnels.betterportal.dev").describe("Tunnel root domain"),
    verificationHost: av.string().default("verify.tunnels.betterportal.dev").describe("Verification host"),
    cookieSecret: av.string().default("dev-cookie-secret").describe("Signed verification cookie secret"),
    turnstileSiteKey: av.optional(av.string()).describe("Cloudflare Turnstile site key"),
    turnstileSecretKey: av.optional(av.string()).describe("Cloudflare Turnstile secret key"),
    maxHeaderBytes: av.number().default(32 * 1024).describe("Maximum accepted request header bytes"),
    maxBodyBytes: av.number().default(2 * 1024 * 1024).describe("Maximum accepted request body bytes")
  }).describe("service-tunnels-proxy config")
);

export const EventSchemas = createEventSchemas({
  emitEvents: {},
  onEvents: {
    "ws.fromOrigin": createFireAndForgetEvent(
      bsb.object({
        publicSocketId: bsb.string({ description: "Web service local websocket id" }),
        frameType: bsb.string({ description: "msg, ack, or event" }),
        event: optional(bsb.string({ description: "close" })),
        body: optional(bsb.string({ description: "Base64 websocket payload" }))
      }, "Origin websocket frame to public client"),
      "Relay an origin websocket frame to the public websocket"
    ),
    "proxy.response.body": createFireAndForgetEvent(
      bsb.object({
        publicRequestId: bsb.string({ description: "Web service local request id" }),
        body: bsb.string({ description: "Base64 encoded response chunk" })
      }, "Proxy response body chunk"),
      "Stream an HTTP response chunk to the public client"
    ),
    "proxy.response.end": createFireAndForgetEvent(
      bsb.object({
        publicRequestId: bsb.string({ description: "Web service local request id" }),
        requestId: bsb.string({ description: "Tunnel request id" }),
        ownerServerId: bsb.string({ description: "Client API server id" }),
        status: bsb.number({ description: "HTTP status" }),
        clientApiRoundtripMs: bsb.number({ description: "Client API to CLI roundtrip duration" }),
        cliOverheadMs: optional(bsb.number({ description: "CLI work outside origin duration" })),
        originMs: optional(bsb.number({ description: "Origin response duration" }))
      }, "Proxy response completion"),
      "Complete a streamed HTTP response"
    ),
    "proxy.response.error": createFireAndForgetEvent(
      bsb.object({
        publicRequestId: bsb.string({ description: "Web service local request id" }),
        message: bsb.string({ description: "Streaming error" })
      }, "Proxy response error"),
      "Fail a streamed HTTP response"
    )
  },
  emitReturnableEvents: {},
  onReturnableEvents: {},
  emitBroadcast: {},
  onBroadcast: {}
});

interface PublicResponse {
  controller: ReadableStreamDefaultController<Uint8Array>;
  hostname: string;
  tunnelId?: string;
  requestObs: Observable;
  startedAt: number;
  bytesIn: number;
  bytesOut: number;
  requestId?: string;
  ownerServerId?: string;
  status?: number;
  settled: boolean;
}

export class Plugin extends BSBService<InstanceType<typeof Config>, typeof EventSchemas> {
  static Config = Config;
  static EventSchemas = EventSchemas;
  readonly initBeforePlugins: string[] = [];
  readonly initAfterPlugins: string[] = [];
  readonly runBeforePlugins: string[] = [];
  readonly runAfterPlugins: string[] = [];
  private readonly clientApi: TunnelClientApiClient;
  private readonly app: H3;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly publicSockets = new Map<string, WebSocket>();
  private readonly publicResponses = new Map<string, PublicResponse>();
  private readonly verification: VerificationFlow;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
    this.clientApi = new TunnelClientApiClient(this);
    this.app = new H3();
    this.server = createServer(toNodeHandler(this.app));
    this.wss = new WebSocketServer({ noServer: true });
    this.verification = createVerificationFlow({
      domain: this.config.domain,
      verificationHost: this.config.verificationHost,
      cookieSecret: this.config.cookieSecret,
      turnstileSiteKey: this.config.turnstileSiteKey,
      turnstileSecretKey: this.config.turnstileSecretKey
    });
  }

  async init(obs: Observable): Promise<void> {
    await initializePrisma(this.config.database.connectionString, obs);
    await this.events.onEventSpecific("ws.fromOrigin", this.appId, obs, async (_handlerObs, input) => {
      const ws = this.publicSockets.get(input.publicSocketId);
      if (!ws || ws.readyState !== ws.OPEN) return;
      if (input.frameType === "msg" && input.body) {
        ws.send(Buffer.from(input.body, "base64"));
        return;
      }
      if (input.frameType === "event" && input.event === "close") ws.close();
    });
    await this.events.onEventSpecific("proxy.response.body", this.appId, obs, async (_handlerObs, input) => {
      const pending = this.publicResponses.get(input.publicRequestId);
      if (!pending || pending.settled) return;
      const chunk = Buffer.from(input.body, "base64");
      pending.bytesOut += chunk.byteLength;
      pending.controller.enqueue(chunk);
    });
    await this.events.onEventSpecific("proxy.response.end", this.appId, obs, async (_handlerObs, input) => {
      const pending = this.publicResponses.get(input.publicRequestId);
      if (!pending || pending.settled) return;
      pending.controller.close();
      this.finishPublicResponse(input.publicRequestId, input);
    });
    await this.events.onEventSpecific("proxy.response.error", this.appId, obs, async (_handlerObs, input) => {
      const pending = this.publicResponses.get(input.publicRequestId);
      if (!pending || pending.settled) return;
      const error = new Error(input.message);
      pending.controller.error(error);
      this.finishPublicResponse(input.publicRequestId, undefined, error);
    });

    this.app.get("/health", () => new Response("ok\n", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    }));

    this.server.on("upgrade", async (request, socket, head) => {
      const host = request.headers.host ?? "";
      const url = new URL(request.url ?? "/", `https://${host}`);
      const headers = requestHeaders(request.headers);
      const clientIp = proxyClientIp(headers) ?? "unknown";
      const userAgent = request.headers["user-agent"] ?? "";
      const userAgentValue = Array.isArray(userAgent) ? userAgent.join(" ") : userAgent;
      const validation = await visitorValidation(url.hostname, clientIp, userAgentValue);
      const verificationResponse = await this.verification.enforce({ req: new Request(url, { headers }) } as never, url, clientIp, userAgentValue, validation.strategy, validation.ipValidated);
      if (this.verification.isVerificationHost(url.hostname) || verificationResponse) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        void this.handlePublicSocket(ws, url, obs);
      });
    });

    this.app.use("/**", async (event) => {
      const url = getRequestURL(event);
      const clientIp = proxyClientIp(event.req.headers) ?? "unknown";
      const userAgent = event.req.headers.get("user-agent") ?? "";

      if (this.verification.isVerificationHost(url.hostname)) {
        return this.verification.handleVerificationHost(event, url, clientIp, userAgent);
      }

      const validation = await visitorValidation(url.hostname, clientIp, userAgent);
      const verificationResponse = await this.verification.enforce(event, url, clientIp, userAgent, validation.strategy, validation.ipValidated);
      if (verificationResponse) return verificationFailureResponse(event.req.method, verificationResponse);

      const requestObs = obs.startSpan("bt.web.request", {
        "http.request.method": event.req.method,
        "url.path": url.pathname,
        "server.address": url.hostname,
        "client.address": clientIp
      });
      const startedAt = Date.now();
      const publicRequestId = randomUUID();
      let bytesIn = 0;
      let bytesOut = 0;
      let usageDeferred = false;

      try {
        requestObs.log.info("WEB REQUEST start {method} {host}{path} clientIp={clientIp}", {
          method: event.req.method,
          host: url.hostname,
          path: url.pathname,
          clientIp
        });
        const headerBytes = approximateHeaderBytes(event.req.headers);
        bytesIn = headerBytes;
        if (headerBytes > this.config.maxHeaderBytes) {
          requestObs.log.warn("WEB REQUEST rejected headers too large {headerBytes}", { headerBytes });
          requestObs.end({ "http.response.status_code": 431 });
          return new Response("Request headers too large.\n", { status: 431 });
        }

        const contentLength = Number(event.req.headers.get("content-length") ?? "0");
        if (contentLength > this.config.maxBodyBytes) {
          requestObs.log.warn("WEB REQUEST rejected body too large {contentLength}", { contentLength });
          requestObs.end({ "http.response.status_code": 413 });
          return new Response("Request body too large.\n", { status: 413 });
        }

        const bodyBuffer = event.req.body ? Buffer.from(await event.req.arrayBuffer()) : undefined;
        bytesIn += bodyBuffer?.byteLength ?? 0;
        if (bodyBuffer && bodyBuffer.byteLength > this.config.maxBodyBytes) {
          requestObs.log.warn("WEB REQUEST rejected buffered body too large {bodyBytes}", { bodyBytes: bodyBuffer.byteLength });
          requestObs.end({ "http.response.status_code": 413 });
          return new Response("Request body too large.\n", { status: 413 });
        }

        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
          cancel: () => this.cancelPublicResponse(publicRequestId)
        });
        const pending: PublicResponse = {
          controller,
          hostname: url.hostname,
          tunnelId: validation.tunnelId,
          requestObs,
          startedAt,
          bytesIn,
          bytesOut: 0,
          settled: false
        };
        this.publicResponses.set(publicRequestId, pending);
        usageDeferred = true;

        const response = await this.clientApi.proxyRequest(obs, {
          publicServerId: this.appId,
          publicRequestId,
          hostname: url.hostname,
          method: event.req.method,
          path: `${url.pathname}${url.search}`,
          headers: forwardedHeaders(event.req.headers, url.hostname),
          body: bodyBuffer ? bodyBuffer.toString("base64") : undefined,
          webStartedAt: startedAt
        }, 310);

        pending.requestId = response.requestId;
        pending.ownerServerId = response.ownerServerId;
        pending.status = response.status;
        pending.bytesOut += approximateRecordHeaderBytes(response.headers);

        if (response.body !== undefined) {
          pending.settled = true;
          this.publicResponses.delete(publicRequestId);
          pending.controller.close();
          const body = Buffer.from(response.body, "base64");
          bytesOut = pending.bytesOut + body.byteLength;
          usageDeferred = false;
          const durationMs = Date.now() - startedAt;
          requestObs.log.info("WEB REQUEST complete {method} {host}{path} -> {status} in {durationMs}ms", {
            method: event.req.method,
            host: url.hostname,
            path: url.pathname,
            status: response.status,
            durationMs
          });
          requestObs.end({ "http.response.status_code": response.status, "duration.ms": durationMs });
          if (response.status === 502 || response.status === 503) return tunnelUnavailable(event.req.headers);
          return buildProxyResponse(body, response.status, response.headers);
        }

        if (response.status === 502 || response.status === 503) {
          this.cancelPublicResponse(publicRequestId, true);
          return tunnelUnavailable(event.req.headers);
        }

        requestObs.log.info("WEB RESPONSE streaming {method} {host}{path} -> {status}", {
          method: event.req.method,
          host: url.hostname,
          path: url.pathname,
          status: response.status
        });
        return buildStreamingProxyResponse(stream, response.status, response.headers);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pending = this.publicResponses.get(publicRequestId);
        if (pending && !pending.settled) {
          pending.controller.error(error);
          this.finishPublicResponse(publicRequestId, undefined, error instanceof Error ? error : new Error(message));
        } else {
          requestObs.error(error instanceof Error ? error : new Error(message), {
            "http.response.status_code": 502
          });
          requestObs.log.error("WEB REQUEST failed {method} {host}{path}: {message}", {
            method: event.req.method,
            host: url.hostname,
            path: url.pathname,
            message
          });
          requestObs.end({ "http.response.status_code": 503 });
        }
        return tunnelUnavailable(event.req.headers);
      } finally {
        const tunnelId = validation.tunnelId;
        if (tunnelId && !usageDeferred) {
          void recordUsage(tunnelId, bytesIn, bytesOut).catch((error) => {
            obs.log.warn("WEB REQUEST usage update failed tunnel={tunnelId}: {message}", {
              tunnelId,
              message: error instanceof Error ? error.message : String(error)
            });
          });
        }
      }
    });
  }

  async run(obs: Observable): Promise<void> {
    const port = this.config.port;
    await new Promise<void>((resolve) => {
      this.server.listen(port, "0.0.0.0", () => resolve());
    });
    obs.log.info(`web listening on port ${port}`);
  }

  async dispose(): Promise<void> {
    this.wss.close();
    for (const publicRequestId of this.publicResponses.keys()) {
      this.cancelPublicResponse(publicRequestId, true);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private finishPublicResponse(publicRequestId: string, completion?: {
    requestId: string;
    ownerServerId: string;
    status: number;
    clientApiRoundtripMs: number;
    cliOverheadMs?: number;
    originMs?: number;
  }, error?: Error): void {
    const pending = this.publicResponses.get(publicRequestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.publicResponses.delete(publicRequestId);
    const durationMs = Date.now() - pending.startedAt;

    if (error) {
      pending.requestObs.error(error, { "http.response.status_code": pending.status ?? 502 });
      pending.requestObs.log.error("WEB RESPONSE stream failed {host}: {message}", {
        host: pending.hostname,
        message: error.message
      });
      pending.requestObs.end({ status: "failed", "duration.ms": durationMs });
    } else {
      const status = completion?.status ?? pending.status ?? 200;
      pending.requestObs.log.info("WEB REQUEST complete {host} -> {status} in {durationMs}ms", {
        host: pending.hostname,
        status,
        durationMs
      });
      pending.requestObs.end({ "http.response.status_code": status, "duration.ms": durationMs });
      if (completion) this.sendProxyMetrics(pending.requestObs, pending.hostname, completion, durationMs);
    }

    this.recordPublicUsage(pending);
  }

  private cancelPublicResponse(publicRequestId: string, closeStream = false): void {
    const pending = this.publicResponses.get(publicRequestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.publicResponses.delete(publicRequestId);
    if (closeStream) pending.controller.close();
    if (pending.ownerServerId && pending.requestId) {
      void this.clientApi.proxyCancelSpecific(pending.ownerServerId, pending.requestObs, {
        hostname: pending.hostname,
        requestId: pending.requestId
      });
    }
    pending.requestObs.end({ status: "cancelled", "duration.ms": Date.now() - pending.startedAt });
    this.recordPublicUsage(pending);
  }

  private recordPublicUsage(pending: PublicResponse): void {
    const tunnelId = pending.tunnelId;
    if (!tunnelId) return;
    void recordUsage(tunnelId, pending.bytesIn, pending.bytesOut).catch((error) => {
      pending.requestObs.log.warn("WEB REQUEST usage update failed tunnel={tunnelId}: {message}", {
        tunnelId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }
  private async handlePublicSocket(ws: WebSocket, url: URL, obs: Observable): Promise<void> {
    const publicSocketId = randomUUID();
    const subdomain = url.hostname.split(".")[0] ?? "";
    const tunnel = await prisma.tunnel.findUnique({ where: { subdomain } });
    if (!tunnel?.ownerServerId || tunnel.status !== "active") {
      ws.close();
      return;
    }

    this.publicSockets.set(publicSocketId, ws);
    await this.clientApi.wsToOriginSpecific(tunnel.ownerServerId, obs, {
      publicServerId: this.appId,
      publicSocketId,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      frameType: "event",
      event: "open"
    });

    ws.on("message", (data) => {
      const body = wsDataBuffer(data).toString("base64");
      void this.clientApi.wsToOriginSpecific(tunnel.ownerServerId!, obs, {
        publicServerId: this.appId,
        publicSocketId,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        frameType: "msg",
        body
      });
    });
    ws.on("close", () => {
      this.publicSockets.delete(publicSocketId);
      void this.clientApi.wsToOriginSpecific(tunnel.ownerServerId!, obs, {
        publicServerId: this.appId,
        publicSocketId,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        frameType: "event",
        event: "close"
      });
    });
  }

  private sendProxyMetrics(obs: Observable, hostname: string, response: {
    requestId: string;
    ownerServerId: string;
    clientApiRoundtripMs: number;
    cliOverheadMs?: number;
    originMs?: number;
  }, totalMs: number): void {
    const internalServerMs = roundMs(totalMs - response.clientApiRoundtripMs);
    void this.clientApi.proxyMetricsSpecific(response.ownerServerId, obs, {
      hostname,
      requestId: response.requestId,
      totalMs,
      clientApiRoundtripMs: response.clientApiRoundtripMs,
      cliOverheadMs: response.cliOverheadMs,
      originMs: response.originMs,
      internalServerMs
    });
  }
}

async function visitorValidation(hostname: string, clientIp: string, userAgent: string): Promise<{ tunnelId?: string; strategy?: string; ipValidated: boolean }> {
  const tunnel = await prisma.tunnel.findUnique({
    where: { subdomain: hostname.split(".")[0] ?? "" },
    select: {
      validation: true,
      id: true,
      validations: {
        where: {
          visitorIpHash: hash(clientIp),
          userAgentHash: hash(userAgent),
          expiresAt: { gt: new Date() }
        },
        select: { id: true },
        take: 1
      }
    }
  });
  return { tunnelId: tunnel?.id, strategy: tunnel?.validation, ipValidated: !!tunnel?.validations.length };
}

async function recordUsage(tunnelId: string, bytesIn: number, bytesOut: number): Promise<void> {
  await prisma.usageCounter.upsert({
    where: { tunnelId },
    create: { tunnelId, requests: 1, bytesIn: BigInt(bytesIn), bytesOut: BigInt(bytesOut) },
    update: {
      requests: { increment: 1 },
      bytesIn: { increment: BigInt(bytesIn) },
      bytesOut: { increment: BigInt(bytesOut) }
    }
  });
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function approximateHeaderBytes(headers: Headers): number {
  let total = 0;
  headers.forEach((value, name) => {
    total += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
  });
  return total;
}

function approximateRecordHeaderBytes(headers: Record<string, string>): number {
  return Object.entries(headers).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value) + 4,
    0
  );
}

function requestHeaders(headers: import("node:http").IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out.set(name, value.join(", "));
    else if (value !== undefined) out.set(name, value);
  }
  return out;
}

function wsDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
