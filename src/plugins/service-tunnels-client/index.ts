import {
  BSBService,
  type BSBServiceConstructor,
  type Observable,
  bsb,
  optional,
  createConfigSchema,
  createEventSchemas,
  createFireAndForgetEvent,
  createReturnableEvent
} from "@bsb/base";
import * as av from "anyvali";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { H3, toNodeHandler } from "h3";
import { WebSocketServer, type WebSocket } from "ws";
import { TunnelCreateSchema, ClientFrameSchema, AuthStartRequestSchema, AuthStartResponseSchema, AuthStatusResponseSchema } from "./schemas.js";
import { buildTunnelSubdomain, hashValue, randomPrefix } from "./ids.js";
import { prisma } from "../../prisma.js";
import { initializePrisma } from "../../prisma.js";
import {
  AUTH_SESSION_TTL_MS,
  DEVICE_TOKEN_TTL_MS,
  bearerToken,
  hashSecret,
  normalizeIpRange,
  randomToken,
  shortBrowserKey,
  verifySecret
} from "../../auth.js";
import { TunnelRegistry, type ActiveTunnel, type PendingRequest } from "./registry.js";
import TunnelWebClient from "../../.bsb/clients/service-tunnels-proxy.js";

export const Config = createConfigSchema(
  {
    name: "service-tunnels-client",
    description: "Client websocket/API service",
    tags: ["service", "websocket", "tunnel"]
  },
  av.object({
    database: av.object({
      connectionString: av.string().minLength(1).describe("PostgreSQL connection string")
    }, { unknownKeys: "strip" }).describe("Database configuration"),
    port: av.number().default(8081).describe("Client API listener port"),
    domain: av.string().default("tunnels.betterportal.dev").describe("Default public tunnel domain"),
    publicUrl: av.string().default("https://tunnels.betterportal.dev").describe("Public base URL"),
    authAppBaseUrl: av.string().default("https://betterportal.cloud").describe("BetterPortal app URL used for CLI auth"),
    authVerifyPath: av.string().default("/cli-auth/verify").describe("BetterPortal CLI auth verify route")
  }).describe("service-tunnels-client config")
);

export const EventSchemas = createEventSchemas({
  emitEvents: {},
  onEvents: {
    "ws.toOrigin": createFireAndForgetEvent(
      bsb.object({
        publicServerId: bsb.string({ description: "Web service instance that owns the public websocket" }),
        publicSocketId: bsb.string({ description: "Web service local websocket id" }),
        hostname: bsb.string({ description: "Public tunnel hostname" }),
        path: bsb.string({ description: "Websocket path and query" }),
        frameType: bsb.string({ description: "msg, ack, or event" }),
        event: optional(bsb.string({ description: "open or close" })),
        body: optional(bsb.string({ description: "Base64 websocket payload" }))
      }, "Public websocket frame to origin"),
      "Relay a public websocket frame to the connected tunnel client"
    ),
    "proxy.metrics": createFireAndForgetEvent(
      bsb.object({
        hostname: bsb.string({ description: "Public tunnel hostname" }),
        requestId: bsb.string({ description: "Request id" }),
        totalMs: bsb.number({ description: "Public request total duration" }),
        clientApiRoundtripMs: optional(bsb.number({ description: "Client API to CLI roundtrip duration" })),
        cliOverheadMs: optional(bsb.number({ description: "CLI work outside origin read duration" })),
        originMs: optional(bsb.number({ description: "CLI to origin/read duration" })),
        internalServerMs: optional(bsb.number({ description: "Remaining server-side duration" }))
      }, "Proxy request metrics"),
      "Send final proxy request timings to the connected tunnel client"
    )
  },
  emitReturnableEvents: {},
  onReturnableEvents: {
    "proxy.request": createReturnableEvent(
      bsb.object({
        hostname: bsb.string({ description: "Public request hostname" }),
        method: bsb.string({ description: "HTTP method" }),
        path: bsb.string({ description: "Path and query" }),
        headers: bsb.record(bsb.string({ description: "Header name" }), bsb.string({ description: "Header value" }), "Headers"),
        body: optional(bsb.string({ description: "Base64 encoded request body" })),
        webStartedAt: bsb.number({ description: "Web service request start timestamp" })
      }, "Proxy request"),
      bsb.object({
        requestId: bsb.string({ description: "Request id" }),
        ownerServerId: bsb.string({ description: "Client API server id" }),
        status: bsb.number({ description: "HTTP status" }),
        headers: bsb.record(bsb.string({ description: "Header name" }), bsb.string({ description: "Header value" }), "Headers"),
        body: bsb.string({ description: "Base64 encoded response body" }),
        webStartedAt: bsb.number({ description: "Web service request start timestamp" }),
        clientApiRoundtripMs: bsb.number({ description: "Client API to CLI roundtrip duration" }),
        cliOverheadMs: optional(bsb.number({ description: "CLI work outside origin read duration" })),
        originMs: optional(bsb.number({ description: "Origin/read duration" }))
      }, "Proxy response"),
      "Proxy an HTTP request through a connected tunnel client",
      60
    )
  },
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
  private readonly registry = new TunnelRegistry();
  private readonly app: H3;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly web: TunnelWebClient;
  private pluginPackageVersion = "0.0.0";

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
    this.app = new H3();
    this.server = createServer(toNodeHandler(this.app));
    this.wss = new WebSocketServer({ noServer: true });
    this.web = new TunnelWebClient(this);
  }

  async init(obs: Observable): Promise<void> {
    await initializePrisma(this.config.database.connectionString, obs);
    this.pluginPackageVersion = await loadPluginPackageVersion(this.packageCwd);
    obs.log.info("init {plugin}", { plugin: this.pluginName });
    await this.events.onReturnableEvent("proxy.request", obs, async (_handlerObs, input) => {
      _handlerObs.log.info("CLIENT API proxy.request {method} {hostname}{path}", {
        method: input.method,
        hostname: input.hostname,
        path: input.path
      });
      const tunnel = this.registry.get(input.hostname);
      const unavailable = {
        requestId: crypto.randomUUID(),
        ownerServerId: this.appId,
        status: 503,
        headers: {},
        body: Buffer.from("Tunnel unavailable").toString("base64"),
        webStartedAt: input.webStartedAt,
        clientApiRoundtripMs: 0
      };
      if (!tunnel) return unavailable;
      if (tunnel.ws.readyState !== tunnel.ws.OPEN) return unavailable;
      return this.proxyRequest(tunnel, input.method, input.path, input.headers, input.body ?? "", input.webStartedAt);
    });
    await this.events.onEventSpecific("proxy.metrics", this.appId, obs, async (_handlerObs, input) => {
      const tunnel = this.registry.get(input.hostname);
      if (!tunnel || tunnel.ws.readyState !== tunnel.ws.OPEN) return;
      tunnel.ws.send(JSON.stringify({
        type: "request.metrics",
        requestId: input.requestId,
        totalMs: input.totalMs,
        clientApiRoundtripMs: input.clientApiRoundtripMs,
        cliOverheadMs: input.cliOverheadMs,
        originMs: input.originMs,
        internalServerMs: input.internalServerMs
      }));
    });
    await this.events.onEventSpecific("ws.toOrigin", this.appId, obs, async (_handlerObs, input) => {
      const tunnel = this.registry.get(input.hostname);
      if (!tunnel || tunnel.ws.readyState !== tunnel.ws.OPEN) {
        await this.web.wsFromOriginSpecific(input.publicServerId, _handlerObs, {
          publicSocketId: input.publicSocketId,
          frameType: "event",
          event: "close"
        });
        return;
      }

      tunnel.ws.send(JSON.stringify({
        type: "ws.toOrigin",
        publicServerId: input.publicServerId,
        publicSocketId: input.publicSocketId,
        path: input.path,
        frameType: input.frameType,
        message: input.event,
        body: input.body
      }));
    });
    const domain = this.config.domain;
    const publicUrl = this.config.publicUrl;

    this.app.get("/health", () => new Response("ok\n", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-bettertunnels-version": this.pluginPackageVersion
      }
    }));

    this.app.get("/api/client/status", async (event) => {
      const token = bearerToken(event.req.headers);
      const auth = await validateDeviceToken(token, proxyClientIpFromHeaders(event.req.headers), event.req.headers.get("user-agent") ?? "");
      if (!auth) return json({ status: "unauthenticated" }, 401);
      return json({
        status: "authenticated",
        serverVersion: this.pluginPackageVersion,
        tenantId: auth.tenantId,
        bpUserSubject: auth.bpUserSubject,
        tokenExpiresAt: auth.expiresAt.toISOString(),
        limits: {
          tunnelTtlHours: 24,
          requestTimeoutSeconds: 300,
          idleTimeoutSeconds: 60,
          customPrefixes: true
        }
      });
    });

    this.app.post("/api/client/auth/start", async (event) => {
      const body = AuthStartRequestSchema.parse(await safeJson(event.req));
      const browserKey = shortBrowserKey();
      const pollSecret = randomToken();
      const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS);
      const authBase = body.authAppBaseUrl ?? this.config.authAppBaseUrl;
      const browserUrl = buildAuthUrl(authBase, this.config.authVerifyPath, browserKey);
      const clientIp = proxyClientIpFromHeaders(event.req.headers);

      const session = await prisma.clientAuthSession.create({
        data: {
          browserKeyHash: hashSecret(browserKey),
          pollSecretHash: hashSecret(pollSecret),
          clientIpHash: hashSecret(clientIp),
          userAgentHash: hashSecret(event.req.headers.get("user-agent") ?? ""),
          expiresAt
        }
      });

      const url = new URL(browserUrl);
      url.searchParams.set("session", session.id);
      url.searchParams.set("key", browserKey);

      return json(AuthStartResponseSchema.parse({
        sessionId: session.id,
        pollSecret,
        browserUrl: url.toString(),
        expiresAt: expiresAt.toISOString()
      }));
    });

    this.app.get("/api/client/auth/status", async (event) => {
      const url = new URL(event.req.url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const pollSecret = bearerToken(event.req.headers) ?? "";
      if (!sessionId || !pollSecret) {
        return json(AuthStatusResponseSchema.parse({ status: "invalid", message: "Missing auth session credentials." }), 401);
      }

      const session = await prisma.clientAuthSession.findUnique({ where: { id: sessionId } });
      if (!session || !verifySecret(pollSecret, session.pollSecretHash)) {
        return json(AuthStatusResponseSchema.parse({ status: "invalid", message: "Invalid auth session." }), 401);
      }
      if (session.expiresAt <= new Date() && session.status === "pending") {
        await prisma.clientAuthSession.update({ where: { id: session.id }, data: { status: "expired" } });
        return json(AuthStatusResponseSchema.parse({ status: "expired", message: "Authentication session expired." }), 410);
      }
      if (session.status === "pending") {
        return json(AuthStatusResponseSchema.parse({ status: "pending" }));
      }
      if (session.status !== "approved" || !session.tenantId || !session.bpUserSubject) {
        return json(AuthStatusResponseSchema.parse({ status: session.status, message: "Authentication session is not approved." }), 409);
      }

      const clientIp = proxyClientIpFromHeaders(event.req.headers);
      const ipRange = normalizeIpRange(clientIp);
      if (!ipRange) {
        return json(AuthStatusResponseSchema.parse({ status: "invalid", message: "Unable to bind token to public IP range." }), 400);
      }

      const deviceToken = `bt_${randomToken(32)}`;
      const tokenExpiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_MS);
      await prisma.$transaction([
        prisma.clientDeviceToken.create({
          data: {
            tenantId: session.tenantId,
            bpUserSubject: session.bpUserSubject,
            tokenHash: hashSecret(deviceToken),
            name: "BetterTunnels CLI",
            ipRangeHash: hashSecret(ipRange.cidr),
            ipFamily: ipRange.family,
            userAgentHash: hashSecret(event.req.headers.get("user-agent") ?? ""),
            expiresAt: tokenExpiresAt
          }
        }),
        prisma.clientAuthSession.update({
          where: { id: session.id },
          data: { status: "consumed", consumedAt: new Date() }
        })
      ]);

      return json(AuthStatusResponseSchema.parse({
        status: "approved",
        token: deviceToken,
        expiresAt: tokenExpiresAt.toISOString(),
        tenantId: session.tenantId,
        bpUserSubject: session.bpUserSubject,
        bpUserEmail: session.bpUserEmail ?? undefined
      }));
    });

    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== "/api/client/ws") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        obs.log.info("CLIENT WS upgrade {path}", { path: url.pathname });
        void this.handleTunnelSocket(ws, url, request.headers["user-agent"] ?? "", proxyClientIp(request.headers), domain, publicUrl, obs);
      });
    });
  }

  async run(obs: Observable): Promise<void> {
    const port = this.config.port;
    await new Promise<void>((resolve) => {
      this.server.listen(port, "0.0.0.0", () => resolve());
    });
    obs.log.info(`client-api listening on port ${port}`);
  }

  async dispose(): Promise<void> {
    this.wss.close();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handleTunnelSocket(ws: WebSocket, url: URL, userAgent: string | string[], clientIp: string, domain: string, publicUrl: string, obs: Observable): Promise<void> {
    const input = TunnelCreateSchema.parse({
      sessionId: url.searchParams.get("sessionId") ?? "",
      targetHost: url.searchParams.get("targetHost") ?? "127.0.0.1",
      targetPort: Number(url.searchParams.get("targetPort") ?? "0"),
      clientVersion: url.searchParams.get("clientVersion") ?? undefined,
      authenticated: url.searchParams.get("authenticated") === "true",
      prefix: url.searchParams.get("prefix") ?? undefined,
      validation: url.searchParams.get("validation") ?? undefined,
      token: url.searchParams.get("token") ?? undefined
    });

    const versionIssue = incompatibleMajor(input.clientVersion, this.pluginPackageVersion);
    if (versionIssue) {
      ws.close(1008, versionIssue);
      obs.log.warn("CLIENT SESSION rejected incompatible version client={clientVersion} server={serverVersion} from {clientIp}", {
        clientVersion: input.clientVersion ?? "unknown",
        serverVersion: this.pluginPackageVersion,
        clientIp
      });
      return;
    }

    const authContext = input.authenticated
      ? await validateDeviceToken(input.token, clientIp, Array.isArray(userAgent) ? userAgent.join(" ") : userAgent)
      : undefined;
    if (input.authenticated && !authContext) {
      ws.close(1008, "reauth required");
      obs.log.warn("CLIENT SESSION rejected authenticated tunnel from {clientIp}", { clientIp });
      return;
    }

    const authenticated = !!authContext;
    const validation = authenticated && input.validation === "ip" ? "ip" : "cookie";
    let subdomain: string | undefined;
    if (!(authenticated && input.prefix)) {
      // Reuse the prior subdomain for this session so reconnects keep the same public URL.
      const prior = await prisma.tunnel.findFirst({
        where: {
          sessionId: input.sessionId,
          targetHost: input.targetHost,
          targetPort: input.targetPort,
          expiresAt: { gt: new Date() }
        },
        orderBy: { expiresAt: "desc" }
      });
      subdomain = prior?.subdomain;
    }
    if (!subdomain) {
      const prefix = authenticated && input.prefix ? input.prefix : randomPrefix();
      subdomain = buildTunnelSubdomain(prefix, input.targetPort, clientIp);
    }
    const expiresAt = new Date(Date.now() + (authenticated ? 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000));
    const sessionObs = this.createTrace("bt.client.session", {
      "bt.client.session_id": input.sessionId,
      "bt.tunnel.subdomain": subdomain,
      "bt.tunnel.authenticated": authenticated,
      "client.address": clientIp
    });
    sessionObs.log.info("CLIENT SESSION connect {subdomain} from {clientIp}", {
      subdomain,
      clientIp
    });

    const session = await prisma.clientSession.upsert({
      where: { id: input.sessionId },
      create: {
        id: input.sessionId,
        accountId: authContext?.accountId,
        userAgent: Array.isArray(userAgent) ? userAgent.join(" ") : userAgent,
        ipHash: hashValue(clientIp),
        expiresAt
      },
      update: { expiresAt }
    });

    const tunnelRow = await prisma.tunnel.upsert({
      where: { subdomain },
      create: {
        sessionId: session.id,
        subdomain,
        ownerServerId: this.appId,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        authenticated,
        validation,
        accountId: authContext?.accountId,
        status: "active",
        expiresAt
      },
      update: {
        sessionId: session.id,
        ownerServerId: this.appId,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        authenticated,
        validation,
        accountId: authContext?.accountId,
        status: "active",
        expiresAt
      }
    });

    const tunnel: ActiveTunnel = {
      id: tunnelRow.id,
      subdomain,
      targetHost: input.targetHost,
      targetPort: input.targetPort,
      authenticated,
      expiresAt,
      ws,
      pending: new Map(),
      sessionObs
    };

    this.registry.set(tunnel);
    sessionObs.log.info("CLIENT TUNNEL active {subdomain} -> {host}:{port}", {
      subdomain,
      host: input.targetHost,
      port: input.targetPort
    });
    ws.send(JSON.stringify({
      type: "tunnel.ready",
      publicUrl: publicUrl.replace(/\/$/, "").replace(`://${domain}`, `://${subdomain}.${domain}`),
      subdomain,
      expiresAt: expiresAt.toISOString(),
      serverVersion: this.pluginPackageVersion
    }));

    ws.on("message", (raw) => this.handleClientFrame(tunnel, raw.toString()));
    ws.on("close", (code, reason) => {
      sessionObs.log.warn("CLIENT TUNNEL disconnected {subdomain}", { subdomain });
      for (const [requestId, pending] of tunnel.pending.entries()) {
        this.failPending(tunnel, requestId, pending, new Error("Tunnel client disconnected."));
      }
      // A reconnect may already own this subdomain; only tear down if this socket is still the registered one.
      if (this.registry.get(subdomain)?.ws === ws) {
        this.registry.delete(subdomain);
        void prisma.tunnel.update({ where: { id: tunnel.id }, data: { status: "disconnected" } }).catch(() => undefined);
      }
      sessionObs.end({ "bt.client.disconnect": true });
      sessionObs.log.warn("CLIENT TUNNEL socket closed {subdomain} code={code} reason={reason}", {
        subdomain,
        code,
        reason: reason.toString()
      });
    });
    ws.on("error", (error) => {
      sessionObs.log.error("CLIENT TUNNEL socket error {subdomain}: {message}", {
        subdomain,
        message: error.message
      });
    });
  }

  private async proxyRequest(tunnel: ActiveTunnel, method: string, path: string, headers: Record<string, string>, body: string, webStartedAt: number): Promise<{ requestId: string; ownerServerId: string; status: number; headers: Record<string, string>; body: string; webStartedAt: number; clientApiRoundtripMs: number; cliOverheadMs?: number; originMs?: number }> {
    const requestId = crypto.randomUUID();
    const clientApiSentAt = Date.now();
    const timeoutMs = tunnel.authenticated ? 5 * 60 * 1000 : 60 * 1000;
    const idleTimeoutMs = tunnel.authenticated ? 60 * 1000 : 30 * 1000;
    const requestObs = tunnel.sessionObs.startSpan("bt.client.proxy", {
      "bt.tunnel.id": tunnel.id,
      "bt.tunnel.subdomain": tunnel.subdomain,
      "http.request.method": method,
      "url.path": path
    });
    requestObs.log.info("CLIENT PROXY start {method} {path} via {subdomain}", {
      method,
      path,
      subdomain: tunnel.subdomain
    });

    const responsePromise = new Promise<{ requestId: string; ownerServerId: string; status: number; headers: Record<string, string>; body: string; webStartedAt: number; clientApiRoundtripMs: number; cliOverheadMs?: number; originMs?: number }>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (response) => {
          void response.arrayBuffer().then((arrayBuffer) => {
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              responseHeaders[key] = value;
            });
            const output = {
              requestId,
              ownerServerId: this.appId,
              status: response.status,
              headers: responseHeaders,
              body: Buffer.from(arrayBuffer).toString("base64"),
              webStartedAt: pending.webStartedAt,
              clientApiRoundtripMs: pending.clientApiRoundtripMs ?? Date.now() - pending.clientApiSentAt,
              cliOverheadMs: pending.cliOverheadMs,
              originMs: pending.originMs
            };
            requestObs.log.info("CLIENT PROXY complete {method} {path} -> {status}", {
              method,
              path,
              status: response.status
            });
            requestObs.end({ "http.response.status_code": response.status });
            resolve(output);
          }).catch(reject);
        },
        reject: (error) => {
          requestObs.error(error);
          requestObs.end({ "status": "failed" });
          reject(error);
        },
        chunks: [],
        webStartedAt,
        clientApiSentAt,
        totalTimer: setTimeout(() => this.failPending(tunnel, requestId, pending, new Error("Local app timed out.")), timeoutMs),
        firstByteTimer: setTimeout(() => this.failPending(tunnel, requestId, pending, new Error("Local app did not acknowledge request within 5s.")), 5 * 1000),
        idleTimeoutMs
      };
      tunnel.pending.set(requestId, pending);
    });

    tunnel.ws.send(JSON.stringify({
      type: "request.start",
      requestId,
      method,
      path,
      headers,
      body,
      webStartedAt,
      clientApiSentAt
    }));

    return responsePromise;
  }

  private handleClientFrame(tunnel: ActiveTunnel, raw: string): void {
    let frame;
    try {
      frame = ClientFrameSchema.parse(JSON.parse(raw));
    } catch (error) {
      tunnel.sessionObs.error(error instanceof Error ? error : new Error(String(error)));
      tunnel.ws.close(1002, "invalid frame");
      return;
    }
    if (frame.type === "ws.fromOrigin" && frame.publicServerId && frame.publicSocketId && frame.frameType) {
      void this.web.wsFromOriginSpecific(frame.publicServerId, tunnel.sessionObs, {
        publicSocketId: frame.publicSocketId,
        frameType: frame.frameType,
        event: frame.message,
        body: frame.body
      });
      return;
    }

    if (!frame.requestId) return;

    const pending = tunnel.pending.get(frame.requestId);
    if (!pending) return;

    if (frame.type === "response.start") {
      clearTimeout(pending.firstByteTimer);
      this.resetIdleTimer(tunnel, frame.requestId, pending);
      pending.status = frame.status ?? 200;
      pending.headers = frame.headers ?? {};
      return;
    }

    if (frame.type === "response.body" && frame.body) {
      this.resetIdleTimer(tunnel, frame.requestId, pending);
      pending.chunks.push(frame.body);
      return;
    }

    if (frame.type === "response.end") {
      pending.clientApiRoundtripMs = Date.now() - pending.clientApiSentAt;
      pending.cliOverheadMs = frame.cliOverheadMs;
      pending.originMs = frame.originMs;
      this.clearPendingTimers(pending);
      tunnel.pending.delete(frame.requestId);
      const buffer = Buffer.concat(pending.chunks.map((chunk) => Buffer.from(chunk, "base64")));
      try {
        pending.resolve(buildProxyResponse(buffer, pending.status ?? 200, stripResponseHeaders(pending.headers ?? {})));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    if (frame.type === "error") {
      this.failPending(tunnel, frame.requestId, pending, new Error(frame.message ?? "Tunnel client error."));
    }
  }

  private resetIdleTimer(tunnel: ActiveTunnel, requestId: string, pending: PendingRequest): void {
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(() => {
      this.failPending(tunnel, requestId, pending, new Error("Local app response stalled."));
    }, pending.idleTimeoutMs);
  }

  private failPending(tunnel: ActiveTunnel, requestId: string, pending: PendingRequest, error: Error): void {
    if (!tunnel.pending.has(requestId)) return;
    this.clearPendingTimers(pending);
    tunnel.pending.delete(requestId);
    pending.reject(error);
  }

  private clearPendingTimers(pending: PendingRequest): void {
    clearTimeout(pending.totalTimer);
    clearTimeout(pending.firstByteTimer);
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
  }
}

function incompatibleMajor(clientVersion: string | undefined, serverVersion: string): string | undefined {
  const client = majorVersion(clientVersion);
  const server = majorVersion(serverVersion);
  if (client === undefined || server === undefined) return undefined;
  if (client !== server) {
    return `BetterTunnels CLI major version ${client} is incompatible with server major version ${server}. Update the CLI.`;
  }
  return undefined;
}

function majorVersion(value: string | undefined): number | undefined {
  const normalized = value?.trim().replace(/^v/, "");
  if (!normalized || normalized === "dev") return undefined;
  const major = Number.parseInt(normalized.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : undefined;
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function loadPluginPackageVersion(packageCwd: string): Promise<string> {
  try {
    const raw = await readFile(join(packageCwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Response() throws on null-body statuses with a body, and on statuses outside 200-599.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function buildProxyResponse(body: Buffer, status: number, headers: HeadersInit): Response {
  const safeStatus = status >= 200 && status <= 599 ? status : 502;
  return new Response(NULL_BODY_STATUSES.has(safeStatus) ? null : new Uint8Array(body), { status: safeStatus, headers });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function buildAuthUrl(base: string, path: string, browserKey: string): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);
  url.searchParams.set("key", browserKey);
  return url.toString();
}

async function validateDeviceToken(token: string | undefined, clientIp: string, userAgent: string): Promise<{ accountId?: string; tenantId: string; bpUserSubject: string; expiresAt: Date } | undefined> {
  if (!token) return undefined;
  const ipRange = normalizeIpRange(clientIp);
  if (!ipRange) return undefined;

  const row = await prisma.clientDeviceToken.findUnique({
    where: { tokenHash: hashSecret(token) }
  });
  if (!row || row.revokedAt || row.expiresAt <= new Date()) return undefined;
  if (row.ipFamily !== ipRange.family || row.ipRangeHash !== hashSecret(ipRange.cidr)) return undefined;
  if (row.userAgentHash && row.userAgentHash !== hashSecret(userAgent)) return undefined;

  await prisma.clientDeviceToken.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date() }
  });
  return {
    accountId: row.accountId ?? undefined,
    tenantId: row.tenantId,
    bpUserSubject: row.bpUserSubject,
    expiresAt: row.expiresAt
  };
}

function proxyClientIp(headers: import("node:http").IncomingHttpHeaders): string {
  const forwardedFor = firstPublicForwardedIp(firstHeader(headers["x-forwarded-for"]));
  if (forwardedFor) return forwardedFor;

  return firstHeader(headers["x-real-ip"])?.trim() || "unknown";
}

function proxyClientIpFromHeaders(headers: Headers): string {
  const forwardedFor = firstPublicForwardedIp(headers.get("x-forwarded-for") ?? undefined);
  if (forwardedFor) return forwardedFor;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function firstPublicForwardedIp(value: string | undefined): string | undefined {
  return value?.split(",").map((ip) => ip.trim()).find((ip) => ip && !isPrivateIp(ip));
}

function isPrivateIp(ip: string): boolean {
  return ip === "unknown"
    || ip.startsWith("10.")
    || ip.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
    || ip.startsWith("127.")
    || ip.startsWith("::1")
    || ip.startsWith("fc")
    || ip.startsWith("fd")
    || ip.startsWith("fe80:");
}

function stripResponseHeaders(headers: Record<string, string>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key === "set-cookie" || key === "connection" || key === "transfer-encoding") continue;
    out.set(name, value);
  }
  return out;
}
