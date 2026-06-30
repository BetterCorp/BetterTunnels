import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import WebSocket, { type RawData } from "ws";
import { FileConfigSchema, TunnelConfigSchema, ClientFrameSchema } from "./plugins/service-tunnel-client-api/schemas.js";

const serverUrl = process.env.BETTER_TUNNELS_SERVER ?? "wss://connect.tunnels.betterportal.dev";
const sessionId = randomUUID();

const [, , command, target, ...args] = process.argv;

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  if (command === "http" && target) {
    const port = Number(target.includes(":") ? target.split(":").at(-1) : target);
    const host = target.includes(":") ? target.split(":").slice(0, -1).join(":") : "127.0.0.1";
    await startTunnel(TunnelConfigSchema.parse({ host, port }));
  } else if (command === "up") {
    const cfg = FileConfigSchema.parse(JSON.parse(await readFile(".bettertunnel.json", "utf8")));
    await Promise.all(cfg.tunnels.map((tunnel) => startTunnel(tunnel)));
  } else if (command === "host" && target === "--dev") {
    const port = Number(args.shift());
    if (!port || args.length === 0) throw new Error("usage: btunnel host --dev <port> <command...>");
    const child = spawn(args.join(" "), [], { shell: true, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    await startTunnel(TunnelConfigSchema.parse({ host: "127.0.0.1", port }));
  } else if (command === "host" && target) {
    const port = Number(args[0] ?? "4173");
    await serveStatic(target, port);
    await startTunnel(TunnelConfigSchema.parse({ host: "127.0.0.1", port }));
  } else {
    console.log("usage: btunnel http <port|host:port>");
    console.log("       btunnel host <dir> [port]");
    console.log("       btunnel host --dev <port> <command...>");
    console.log("       btunnel up");
  }
}

async function startTunnel(config: { host: string; port: number; prefix?: string; host_header?: string }): Promise<void> {
  const url = new URL("/api/client/ws", serverUrl);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("targetHost", config.host);
  url.searchParams.set("targetPort", String(config.port));
  if (config.prefix) url.searchParams.set("prefix", config.prefix);

  let attempt = 0;
  const connect = () => {
    const ws = new WebSocket(url);
    const originSockets = new Map<string, WebSocket>();
    const requests = new Map<string, { method: string; path: string; status: number; originMs: number }>();
    let alive = true;
    let reconnect = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        console.warn(`Tunnel heartbeat missed for ${config.host}:${config.port}; reconnecting.`);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30_000);

    ws.on("open", () => {
      attempt = 0;
      alive = true;
      console.log(`Connected: ${serverUrl}`);
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", (error) => {
      console.error(`Tunnel socket error for ${config.host}:${config.port}: ${error.message}`);
    });
    ws.on("close", (code, reason) => {
      clearInterval(heartbeat);
      for (const origin of originSockets.values()) origin.close();
      originSockets.clear();
      console.warn(`Tunnel closed for ${config.host}:${config.port}: code=${code} reason=${reason.toString() || "none"}`);
      if (!reconnect || code === 1002 || code === 1008) return;
      const delay = retryDelay(++attempt);
      console.warn(`Reconnecting ${config.host}:${config.port} in ${delay / 1000}s...`);
      setTimeout(connect, delay);
    });

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = ClientFrameSchema.parse(JSON.parse(raw.toString()));
      } catch (error) {
        reconnect = false;
        console.error(`Tunnel protocol error for ${config.host}:${config.port}: ${error instanceof Error ? error.message : String(error)}`);
        ws.close(1002, "protocol error");
        return;
      }

      if (frame.type === "tunnel.ready") {
        const ready = JSON.parse(raw.toString()) as { publicUrl: string; expiresAt: string };
        console.log("Tunnel active");
        console.log(`Local:  http://${config.host}:${config.port}`);
        console.log(`Public: ${ready.publicUrl}`);
        console.log(`TTL:    ${ready.expiresAt}`);
        return;
      }

      if (frame.type === "tunnel.closed") {
        console.warn(`Tunnel closed by server: code=${frame.code ?? "-"} reason=${frame.message ?? "none"}`);
        ws.close();
        return;
      }

      if (frame.type === "request.metrics" && frame.requestId) {
        const request = requests.get(frame.requestId);
        requests.delete(frame.requestId);
        const label = request ? `${request.method} ${request.path} -> ${request.status}` : frame.requestId;
        console.log(`${label} total=${fmt(frame.totalMs)} tunnel=${fmt(frame.clientApiRoundtripMs)} origin=${fmt(frame.originMs)} cli=${fmt(frame.cliOverheadMs)} server=${fmt(frame.internalServerMs)}`);
        return;
      }

      if (frame.type === "ws.toOrigin" && frame.publicServerId && frame.publicSocketId && frame.frameType) {
        const socketId = frame.publicSocketId;
        if (frame.frameType === "event" && frame.message === "open") {
          const origin = new WebSocket(`ws://${config.host}:${config.port}${frame.path ?? "/"}`);
          originSockets.set(socketId, origin);
          origin.on("open", () => ws.send(JSON.stringify({
            type: "ws.fromOrigin",
            publicServerId: frame.publicServerId,
            publicSocketId: socketId,
            frameType: "ack"
          })));
          origin.on("message", (data) => ws.send(JSON.stringify({
            type: "ws.fromOrigin",
            publicServerId: frame.publicServerId,
            publicSocketId: socketId,
            frameType: "msg",
            body: wsDataBuffer(data).toString("base64")
          })));
          origin.on("close", () => {
            originSockets.delete(socketId);
            ws.send(JSON.stringify({
              type: "ws.fromOrigin",
              publicServerId: frame.publicServerId,
              publicSocketId: socketId,
              frameType: "event",
              message: "close"
            }));
          });
          origin.on("error", () => origin.close());
          return;
        }

        const origin = originSockets.get(socketId);
        if (!origin) return;
        if (frame.frameType === "msg" && frame.body) origin.send(Buffer.from(frame.body, "base64"));
        if (frame.frameType === "event" && frame.message === "close") origin.close();
        return;
      }

      if (frame.type !== "request.start" || !frame.requestId) return;

      const request = JSON.parse(raw.toString()) as {
        requestId: string;
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: string;
        webStartedAt?: number;
      };

      try {
        const cliStartedAt = Date.now();
        const headers = { ...request.headers };
        if (config.host_header) headers.host = config.host_header;
        const response = await localRequest(config.host, config.port, request.method, request.path, headers, request.body);
        const cliOverheadMs = Math.max(0, Date.now() - cliStartedAt - response.originMs);

        ws.send(JSON.stringify({
          type: "response.start",
          requestId: request.requestId,
          status: response.status,
          headers: response.headers
        }));
        ws.send(JSON.stringify({
          type: "response.body",
          requestId: request.requestId,
          body: response.body
        }));
        ws.send(JSON.stringify({
          type: "response.end",
          requestId: request.requestId,
          cliOverheadMs,
          originMs: response.originMs
        }));
        requests.set(request.requestId, {
          method: request.method,
          path: request.path,
          status: response.status,
          originMs: response.originMs
        });
      } catch (error) {
        ws.send(JSON.stringify({
          type: "error",
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error)
        }));
      }
    });
  };

  connect();
  await new Promise(() => undefined);
}

function localRequest(host: string, port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Record<string, string>; body: string; originMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const req = httpRequest({ host, port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) responseHeaders[key] = value.join(", ");
          else if (value !== undefined) responseHeaders[key] = value;
        }
        resolve({
          status: res.statusCode ?? 502,
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString("base64"),
          originMs: Date.now() - startedAt
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(Buffer.from(body, "base64"));
    req.end();
  });
}

async function serveStatic(root: string, port: number): Promise<void> {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const requested = resolve(join(base, decodeURIComponent(url.pathname)));
      const rel = relative(base, requested);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        res.writeHead(403).end("Forbidden");
        return;
      }

      let file = requested;
      const info = await stat(file).catch(() => undefined);
      if (info?.isDirectory()) file = join(file, "index.html");

      const fileInfo = await stat(file);
      if (!fileInfo.isFile()) {
        res.writeHead(404).end("Not found");
        return;
      }

      res.writeHead(200, { "content-type": contentType(file) });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });

  await new Promise<void>((resolveReady) => server.listen(port, "127.0.0.1", resolveReady));
  console.log(`Static: http://127.0.0.1:${port}`);
}

function contentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

function wsDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function fmt(value: number | undefined): string {
  return value === undefined ? "-" : `${Math.max(0, Math.round(value))}ms`;
}

function retryDelay(attempt: number): number {
  return [1_000, 2_000, 5_000, 10_000, 30_000][Math.min(attempt - 1, 4)] ?? 30_000;
}
