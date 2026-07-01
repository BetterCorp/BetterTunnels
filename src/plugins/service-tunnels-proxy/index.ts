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
import { forwardedHeaders, proxyClientIp, tunnelUnavailable } from "./http.js";
import { createVerificationFlow, type VerificationFlow } from "./verification.js";
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
    }, { unknownKeys: "strip" }).describe("Database configuration"),
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
    )
  },
  emitReturnableEvents: {},
  onReturnableEvents: {},
  emitBroadcast: {},
  onBroadcast: {}
});

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

    this.app.get("/health", () => new Response("ok\n", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    }));

    this.server.on("upgrade", (request, socket, head) => {
      const host = request.headers.host ?? "";
      const url = new URL(request.url ?? "/", `https://${host}`);
      const headers = requestHeaders(request.headers);
      const clientIp = proxyClientIp(headers) ?? "unknown";
      const userAgent = request.headers["user-agent"] ?? "";
      const verificationResponse = this.verification.enforce({ req: new Request(url, { headers }) } as never, url, clientIp, Array.isArray(userAgent) ? userAgent.join(" ") : userAgent);
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

      const verificationResponse = this.verification.enforce(event, url, clientIp, userAgent);
      if (verificationResponse) return verificationResponse;

      const requestObs = obs.startSpan("bt.web.request", {
        "http.request.method": event.req.method,
        "url.path": url.pathname,
        "server.address": url.hostname,
        "client.address": clientIp
      });
      const startedAt = Date.now();

      try {
        requestObs.log.info("WEB REQUEST start {method} {host}{path} clientIp={clientIp}", {
          method: event.req.method,
          host: url.hostname,
          path: url.pathname,
          clientIp
        });
        const headerBytes = approximateHeaderBytes(event.req.headers);
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
        if (bodyBuffer && bodyBuffer.byteLength > this.config.maxBodyBytes) {
          requestObs.log.warn("WEB REQUEST rejected buffered body too large {bodyBytes}", { bodyBytes: bodyBuffer.byteLength });
          requestObs.end({ "http.response.status_code": 413 });
          return new Response("Request body too large.\n", { status: 413 });
        }

        const response = await this.clientApi.proxyRequest(obs, {
          hostname: url.hostname,
          method: event.req.method,
          path: `${url.pathname}${url.search}`,
          headers: forwardedHeaders(event.req.headers, url.hostname),
          body: bodyBuffer ? bodyBuffer.toString("base64") : undefined,
          webStartedAt: startedAt
        }, 60);

        const durationMs = Date.now() - startedAt;
        this.sendProxyMetrics(obs, url.hostname, response, durationMs);
        requestObs.log.info("WEB REQUEST complete {method} {host}{path} -> {status} in {durationMs}ms", {
          method: event.req.method,
          host: url.hostname,
          path: url.pathname,
          status: response.status,
          durationMs
        });
        requestObs.end({
          "http.response.status_code": response.status,
          "duration.ms": durationMs
        });

        if (response.status === 502 || response.status === 503) {
          return tunnelUnavailable(event.req.headers);
        }

        return new Response(Buffer.from(response.body, "base64"), {
          status: response.status,
          headers: response.headers
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
        return tunnelUnavailable(event.req.headers);
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
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
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
    webStartedAt: number;
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
