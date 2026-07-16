const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function forwardedHeaders(headers: Headers, hostname: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clientIp = proxyClientIp(headers);
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) return;
    if (key === "cookie") return;
    out[key] = value;
  });
  out["x-forwarded-host"] = hostname;
  out["x-forwarded-proto"] = "https";
  if (clientIp) {
    out["x-forwarded-for"] = clientIp;
    out["x-real-ip"] = clientIp;
  }
  return out;
}

export function proxyClientIp(headers: Headers): string | undefined {
  const forwardedFor = firstPublicForwardedIp(headers.get("x-forwarded-for") ?? undefined);
  if (forwardedFor) return forwardedFor;

  return headers.get("x-real-ip")?.trim() || undefined;
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

// Response() throws on null-body statuses with a body, and on statuses outside 200-599.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function buildProxyResponse(body: Buffer, status: number, headers: HeadersInit): Response {
  const safeStatus = status >= 200 && status <= 599 ? status : 502;
  return new Response(NULL_BODY_STATUSES.has(safeStatus) ? null : new Uint8Array(body), { status: safeStatus, headers });
}

export function verificationFailureResponse(method: string, response: Response): Response {
  if (method !== "OPTIONS") return response;
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "*",
      "access-control-allow-headers": "*",
      "access-control-max-age": "0",
      "cache-control": "no-store"
    }
  });
}

export function tunnelUnavailable(headers: Headers, status = 503): Response {
  const accept = headers.get("accept")?.toLowerCase() ?? "";
  const payload = {
    error: "tunnel_unavailable",
    message: "This development tunnel is not available right now.",
    status
  };

  if (!accept || accept.includes("text/html") || accept.includes("application/xhtml+xml") || accept.includes("*/*")) {
    return tunnelUnavailableHtml(status);
  }

  if (accept.includes("application/json")) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  if (accept.includes("xml")) {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<error>
  <code>${payload.error}</code>
  <message>${payload.message}</message>
  <status>${status}</status>
</error>
`, {
      status,
      headers: { "content-type": "application/xml; charset=utf-8" }
    });
  }

  if (accept.includes("text/plain")) {
    return new Response(`${payload.message}\n`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  return tunnelUnavailableHtml(status);
}

function tunnelUnavailableHtml(status: number): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Development tunnel unavailable</title>
  <style>
    :root { color-scheme: dark; --bg: #120506; --panel: #1b0b0d; --line: #5b2027; --text: #fff6f6; --muted: #f0b8bd; --danger: #ff344c; --danger2: #ff6b7b; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #3b0c13 0, #120506 46%, #080203 100%); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(560px, 100%); border: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,52,76,.14), rgba(255,255,255,.02)), var(--panel); border-radius: 12px; box-shadow: 0 28px 90px rgba(0,0,0,.5); padding: 30px; }
    .brand { color: var(--danger2); font-weight: 900; letter-spacing: .1em; text-transform: uppercase; font-size: 12px; }
    h1 { margin: 18px 0 0; font-size: clamp(34px, 7vw, 62px); line-height: .95; letter-spacing: 0; }
    p { margin: 18px 0 0; color: var(--muted); font-size: 18px; line-height: 1.45; }
    .notice { border: 1px solid var(--danger); background: rgba(255,52,76,.12); padding: 16px; border-radius: 8px; margin-top: 22px; font-weight: 800; }
    small { display: block; margin-top: 18px; color: #d8969d; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <div class="brand">BetterTunnels</div>
    <h1>Unavailable.</h1>
    <p>This is a temporary developer tunnel. It is not a real login, bank, Microsoft, or production service.</p>
    <div class="notice">This tunnel is not available right now, or the local service is not responding.</div>
    <small>Status ${status}. Close this tab unless you expected this exact developer tunnel.</small>
  </main>
</body>
</html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}
