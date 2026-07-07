import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import WebSocket, { type RawData } from "ws";
import { FileConfigSchema, TunnelConfigSchema, ClientFrameSchema, type TunnelEntry } from "./plugins/service-tunnels-client/schemas.js";

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
    const rawConfig = (await readFile(".bettertunnel.json", "utf8")).replace(/^﻿/, "");
    const cfg = FileConfigSchema.parse(JSON.parse(rawConfig));
    if (cfg.tunnels.length === 0) throw new Error("no tunnels defined in .bettertunnel.json");
    for (const [i, t] of cfg.tunnels.entries()) {
      const label = entryLabel(t, i);
      if (t.run && t.dir) throw new Error(`tunnel ${label}: run and dir are mutually exclusive`);
      if (!t.dir && !t.port) throw new Error(`tunnel ${label}: port is required unless dir is set`);
      if (t.cwd && !t.run) throw new Error(`tunnel ${label}: cwd requires run`);
    }
    const children: ReturnType<typeof spawn>[] = [];
    let shuttingDown = false;
    const killAll = () => { shuttingDown = true; for (const child of children) child.kill(); };
    process.on("SIGINT", () => { killAll(); process.exit(0); });
    await Promise.all(cfg.tunnels.map(async (entry, i) => {
      const label = entryLabel(entry, i);
      const t = { ...entry };
      if (t.dir) {
        t.host = "127.0.0.1";
        t.port = await serveStatic(t.dir, t.port ?? 0);
      }
      if (t.run) {
        const child = spawn(t.run, [], { shell: true, cwd: t.cwd, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(prefixLines(label, chunk)));
        child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(prefixLines(label, chunk)));
        child.on("exit", (code) => {
          if (shuttingDown) return;
          console.error(`[${label}] service exited with code ${code}`);
          killAll();
          process.exit(1);
        });
        children.push(child);
        console.log(`[${label}] starting: ${t.run}`);
      }
      if (t.run || t.health) await waitReady(t.host, t.port as number, t.health, t.ready_timeout, label);
      await startTunnel({ host: t.host, port: t.port as number, prefix: t.prefix, host_header: t.host_header });
    }));
  } else if (command === "host" && target === "--dev") {
    const leadingFlag = args[0] === "--port" || args[0]?.startsWith("--port=");
    const { port, rest } = leadingFlag ? takePortFlag(args) : { port: undefined, rest: args };
    if (!port || rest.length === 0) throw new Error("usage: btunnel host --dev --port <port> <command...>");
    const child = spawn(rest.join(" "), [], { shell: true, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    await startTunnel(TunnelConfigSchema.parse({ host: "127.0.0.1", port }));
  } else if (command === "host" && target && !target.startsWith("--")) {
    const { port } = takePortFlag(args);
    const actualPort = await serveStatic(target, port ?? 0);
    await startTunnel(TunnelConfigSchema.parse({ host: "127.0.0.1", port: actualPort }));
  } else {
    console.log("usage: btunnel http <port|host:port>");
    console.log("       btunnel host <dir> [--port <port>]");
    console.log("       btunnel host --dev --port <port> <command...>");
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
      console.error(`Tunnel server unreachable for ${config.host}:${config.port} (server-side issue, your local service is fine): ${error.message}`);
    });
    ws.on("close", (code, reason) => {
      clearInterval(heartbeat);
      for (const origin of originSockets.values()) origin.close();
      originSockets.clear();
      console.warn(`Tunnel server connection lost for ${config.host}:${config.port} (server-side, your local service is fine): code=${code} reason=${reason.toString() || "none"}`);
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

function entryLabel(t: TunnelEntry, i: number): string {
  if (t.name) return t.name;
  if (t.dir) return t.dir;
  if (t.port) return `${t.host}:${t.port}`;
  return `tunnel[${i}]`;
}

function prefixLines(label: string, chunk: Buffer): string {
  return chunk
    .toString()
    .split("\n")
    .filter((line, idx, all) => idx < all.length - 1 || line !== "")
    .map((line) => `[${label}] ${line.replace(/\r$/, "")}\n`)
    .join("");
}

async function waitReady(host: string, port: number, health: string | undefined, timeoutSec: number | undefined, label: string): Promise<void> {
  const timeoutMs = (timeoutSec && timeoutSec > 0 ? timeoutSec : 30) * 1000;
  const deadline = Date.now() + timeoutMs;
  const healthUrl = health ? `http://${host}:${port}${health.startsWith("/") ? health : `/${health}`}` : undefined;
  for (;;) {
    if (healthUrl) {
      const ok = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) }).then((r) => r.status < 400).catch(() => false);
      if (ok) {
        console.log(`[${label}] ready: ${healthUrl}`);
        return;
      }
    } else {
      const ok = await new Promise<boolean>((resolveProbe) => {
        const socket = netConnect({ host, port, timeout: 1000 });
        socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
        socket.once("error", () => resolveProbe(false));
        socket.once("timeout", () => { socket.destroy(); resolveProbe(false); });
      });
      if (ok) {
        console.log(`[${label}] ready: tcp ${host}:${port}`);
        return;
      }
    }
    if (Date.now() > deadline) throw new Error(`[${label}] not ready after ${timeoutMs / 1000}s (${host}:${port})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function takePortFlag(args: string[]): { port: number | undefined; rest: string[] } {
  const rest = [...args];
  let port: number | undefined;
  const flagIndex = rest.findIndex((a) => a === "--port" || a.startsWith("--port="));
  if (flagIndex !== -1) {
    const flag = rest[flagIndex];
    const raw = flag === "--port" ? rest[flagIndex + 1] : flag.slice("--port=".length);
    port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid --port value: ${raw}`);
    rest.splice(flagIndex, flag === "--port" ? 2 : 1);
  }
  return { port, rest };
}

async function serveStatic(root: string, port: number): Promise<number> {
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

  await new Promise<void>((resolveReady, reject) => {
    server.once("error", (err) => reject(new Error(`cannot host on port ${port}: ${err.message}`)));
    server.listen(port, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`Static: http://127.0.0.1:${actual}`);
  return actual;
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
  return [1_000, 2_000, 3_000, 5_000][Math.min(attempt - 1, 3)] ?? 5_000;
}
