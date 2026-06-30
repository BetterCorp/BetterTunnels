import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { H3Event } from "h3";

const WIDE_COOKIE = "bt_verify";
const HOST_COOKIE = "bt_tunnel";
const CHALLENGE_PARAM = "bt_challenge";
const COOKIE_TTL_SECONDS = 60 * 60;
const CHALLENGE_TTL_SECONDS = 2 * 60;

type Token = {
  kind: "wide" | "host" | "challenge";
  ip: string;
  ua: string;
  exp: number;
  host?: string;
};

type VerificationConfig = {
  domain: string;
  verificationHost: string;
  cookieSecret: string;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
};

export class VerificationFlow {
  constructor(private readonly config: VerificationConfig) {}

  isVerificationHost(hostname: string): boolean {
    return hostname === this.config.verificationHost;
  }

  async handleVerificationHost(event: H3Event, url: URL, clientIp: string, userAgent: string): Promise<Response> {
    if (event.req.method === "POST") {
      const form = await event.req.formData();
      const returnTo = String(form.get("return") ?? "");
      const turnstileToken = String(form.get("cf-turnstile-response") ?? "");
      if (!this.isAllowedReturn(returnTo)) return new Response("Invalid return URL.\n", { status: 400 });
      if (!await this.verifyTurnstile(turnstileToken, clientIp)) {
        return this.verificationPage(returnTo, "Verification failed. Please try again.");
      }

      return this.redirectWithWideCookie(returnTo, clientIp, userAgent);
    }

    const returnTo = url.searchParams.get("return") ?? "";
    if (!this.isAllowedReturn(returnTo)) return new Response("Invalid return URL.\n", { status: 400 });
    if (this.validWideCookie(event.req.headers, clientIp, userAgent)) {
      return this.redirectWithChallenge(returnTo, clientIp, userAgent);
    }
    return this.verificationPage(returnTo);
  }

  enforce(event: H3Event, url: URL, clientIp: string, userAgent: string): Response | undefined {
    if (this.validHostCookie(event.req.headers, url.hostname, clientIp, userAgent)) return undefined;

    const challenge = url.searchParams.get(CHALLENGE_PARAM);
    if (challenge && this.verifyToken(challenge, "challenge", clientIp, userAgent, url.hostname)) {
      const cleanUrl = new URL(url);
      cleanUrl.searchParams.delete(CHALLENGE_PARAM);
      return redirect(cleanUrl.toString(), hostCookie(HOST_COOKIE, this.signToken("host", clientIp, userAgent, url.hostname)));
    }

    const verifyUrl = new URL(`https://${this.config.verificationHost}/`);
    verifyUrl.searchParams.set("return", url.toString());
    return redirect(verifyUrl.toString());
  }

  private redirectWithWideCookie(returnTo: string, clientIp: string, userAgent: string): Response {
    const response = this.redirectWithChallenge(returnTo, clientIp, userAgent);
    response.headers.append("set-cookie", wideCookie(WIDE_COOKIE, this.signToken("wide", clientIp, userAgent), this.config.domain));
    return response;
  }

  private redirectWithChallenge(returnTo: string, clientIp: string, userAgent: string): Response {
    const target = new URL(returnTo);
    target.searchParams.set(CHALLENGE_PARAM, this.signToken("challenge", clientIp, userAgent, target.hostname, CHALLENGE_TTL_SECONDS));
    return redirect(target.toString());
  }

  private validWideCookie(headers: Headers, clientIp: string, userAgent: string): boolean {
    const token = readCookie(headers, WIDE_COOKIE);
    return !!token && this.verifyToken(token, "wide", clientIp, userAgent);
  }

  private validHostCookie(headers: Headers, host: string, clientIp: string, userAgent: string): boolean {
    const token = readCookie(headers, HOST_COOKIE);
    return !!token && this.verifyToken(token, "host", clientIp, userAgent, host);
  }

  private signToken(kind: Token["kind"], clientIp: string, userAgent: string, host?: string, ttl = COOKIE_TTL_SECONDS): string {
    const payload: Token = {
      kind,
      ip: hash(clientIp),
      ua: hash(userAgent),
      exp: Math.floor(Date.now() / 1000) + ttl,
      ...(host ? { host } : {})
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${hmac(body, this.config.cookieSecret)}`;
  }

  private verifyToken(raw: string, kind: Token["kind"], clientIp: string, userAgent: string, host?: string): boolean {
    const [body, sig] = raw.split(".");
    if (!body || !sig || !safeEqual(sig, hmac(body, this.config.cookieSecret))) return false;

    let token: Token;
    try {
      token = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Token;
    } catch {
      return false;
    }

    return token.kind === kind
      && token.exp >= Math.floor(Date.now() / 1000)
      && token.ip === hash(clientIp)
      && token.ua === hash(userAgent)
      && (!host || token.host === host);
  }

  private isAllowedReturn(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && url.hostname !== this.config.verificationHost
        && (url.hostname === this.config.domain || url.hostname.endsWith(`.${this.config.domain}`));
    } catch {
      return false;
    }
  }

  private async verifyTurnstile(token: string, clientIp: string): Promise<boolean> {
    if (!this.config.turnstileSecretKey) return true;
    if (!token) return false;

    const body = new URLSearchParams({
      secret: this.config.turnstileSecretKey,
      response: token,
      remoteip: clientIp
    });
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body
    });
    const result = await response.json() as { success?: boolean };
    return result.success === true;
  }

  private verificationPage(returnTo: string, error?: string): Response {
    const escapedReturn = escapeHtml(returnTo);
    const widget = this.config.turnstileSiteKey
      ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(this.config.turnstileSiteKey)}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
      : "";
    const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";

    return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Continue to development tunnel</title>
  <style>
    :root { color-scheme: dark; --bg: #120506; --panel: #1b0b0d; --line: #5b2027; --text: #fff6f6; --muted: #f0b8bd; --danger: #ff344c; --danger2: #ff6b7b; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #3b0c13 0, #120506 46%, #080203 100%); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(560px, 100%); border: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,52,76,.14), rgba(255,255,255,.02)), var(--panel); border-radius: 12px; box-shadow: 0 28px 90px rgba(0,0,0,.5); padding: 30px; }
    .brand { color: var(--danger2); font-weight: 900; letter-spacing: .1em; text-transform: uppercase; font-size: 12px; }
    h1 { margin: 18px 0 0; font-size: clamp(34px, 7vw, 62px); line-height: .95; letter-spacing: 0; }
    p { margin: 18px 0 0; color: var(--muted); font-size: 18px; line-height: 1.45; }
    .notice { border: 1px solid var(--danger); background: rgba(255,52,76,.12); padding: 16px; border-radius: 8px; margin-top: 22px; font-weight: 800; }
    form { margin-top: 24px; display: grid; gap: 18px; }
    button { height: 50px; border: 0; border-radius: 8px; background: var(--danger); color: white; font-weight: 900; font-size: 15px; cursor: pointer; }
    button:hover { background: #e6273d; }
    .error { color: #ff9f9f; }
    small { display: block; margin-top: 18px; color: #d8969d; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <div class="brand">BetterTunnels</div>
    <h1>Stop.</h1>
    <p>This is a temporary developer tunnel. It is not a real login, bank, Microsoft, or production service.</p>
    <div class="notice">If you did not expect this exact developer tunnel, close this tab.</div>
    ${errorHtml}
    <form method="post">
      <input type="hidden" name="return" value="${escapedReturn}">
      ${widget}
      <button type="submit">I expected this tunnel</button>
    </form>
    <small>Continuing verifies this browser and IP for a short time.</small>
  </main>
</body>
</html>`, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function readCookie(headers: Headers, name: string): string | undefined {
  const cookie = headers.get("cookie") ?? "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function wideCookie(name: string, value: string, domain: string): string {
  return `${name}=${value}; Max-Age=${COOKIE_TTL_SECONDS}; Domain=.${domain}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function hostCookie(name: string, value: string): string {
  return `${name}=${value}; Max-Age=${COOKIE_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char] ?? char);
}

export function createVerificationFlow(config: VerificationConfig): VerificationFlow {
  return new VerificationFlow(config);
}
