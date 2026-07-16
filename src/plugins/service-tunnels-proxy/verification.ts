import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { H3Event } from "h3";
import { prisma } from "../../prisma.js";

const WIDE_COOKIE = "bt_verify";
const HOST_COOKIE = "bt_tunnel";
const CHALLENGE_PARAM = "bt_challenge";
const COOKIE_TTL_SECONDS = 60 * 60;
const CHALLENGE_TTL_SECONDS = 2 * 60;

type Token = {
  kind: "wide" | "host" | "challenge" | "embed";
  ip: string;
  ua: string;
  exp: number;
  host?: string;
  origin?: string;
};

type EmbeddedState = {
  origin: string;
  token: string;
  browserReturn?: string;
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
    const form = event.req.method === "POST" ? await event.req.formData() : undefined;
    const returnTo = form ? String(form.get("return") ?? "") : url.searchParams.get("return") ?? "";
    if (!this.isAllowedReturn(returnTo)) return invalidResponse("Invalid return URL.\n");

    const embedded = this.readEmbeddedState(url, returnTo, clientIp, userAgent);
    if (embedded === null) return invalidResponse("Invalid embedded return URL.\n");

    if (form) {
      const turnstileToken = String(form.get("cf-turnstile-response") ?? "");
      if (!await this.verifyTurnstile(turnstileToken, clientIp)) {
        return this.verificationPage(returnTo, embedded, "Verification failed. Please try again.");
      }

      const ipValidated = await this.recordIpValidation(returnTo, clientIp, userAgent);
      if (embedded?.browserReturn && ipValidated) return redirect(embedded.browserReturn);
      return this.redirectWithWideCookie(returnTo, clientIp, userAgent);
    }

    if (this.validWideCookie(event.req.headers, clientIp, userAgent)) {
      const ipValidated = await this.recordIpValidation(returnTo, clientIp, userAgent);
      if (embedded?.browserReturn && ipValidated) return redirect(embedded.browserReturn);
      return this.redirectWithChallenge(returnTo, clientIp, userAgent);
    }
    return this.verificationPage(returnTo, embedded);
  }

  async enforce(event: H3Event, url: URL, clientIp: string, userAgent: string, validation: string = "cookie", ipValidated = false): Promise<Response | undefined> {
    if (this.validHostCookie(event.req.headers, url.hostname, clientIp, userAgent)) {
      if (validation === "ip" && !ipValidated) await this.recordIpValidation(url.toString(), clientIp, userAgent);
      return undefined;
    }

    const challenge = url.searchParams.get(CHALLENGE_PARAM);
    if (challenge && this.verifyToken(challenge, "challenge", clientIp, userAgent, { host: url.hostname })) {
      const cleanUrl = new URL(url);
      cleanUrl.searchParams.delete(CHALLENGE_PARAM);
      return redirect(cleanUrl.toString(), hostCookie(HOST_COOKIE, this.signToken("host", clientIp, userAgent, { host: url.hostname })));
    }
    if (validation === "ip" && ipValidated) return undefined;

    const verifyUrl = this.verificationUrl(url.toString());
    if (validation === "ip") {
      const origin = embeddedOrigin(event.req.headers.get("origin"), this.config.verificationHost);
      if (origin) {
        verifyUrl.searchParams.set("embed_origin", origin);
        verifyUrl.searchParams.set("embed_token", this.signToken("embed", clientIp, userAgent, {
          host: url.hostname,
          origin
        }));
      }
    }
    return redirect(verifyUrl.toString());
  }

  private redirectWithWideCookie(returnTo: string, clientIp: string, userAgent: string): Response {
    const response = this.redirectWithChallenge(returnTo, clientIp, userAgent);
    response.headers.append("set-cookie", wideCookie(WIDE_COOKIE, this.signToken("wide", clientIp, userAgent), this.config.domain));
    return response;
  }

  private redirectWithChallenge(returnTo: string, clientIp: string, userAgent: string): Response {
    const target = new URL(returnTo);
    target.searchParams.set(CHALLENGE_PARAM, this.signToken("challenge", clientIp, userAgent, {
      host: target.hostname,
      ttl: CHALLENGE_TTL_SECONDS
    }));
    return redirect(target.toString());
  }

  private validWideCookie(headers: Headers, clientIp: string, userAgent: string): boolean {
    const token = readCookie(headers, WIDE_COOKIE);
    return !!token && this.verifyToken(token, "wide", clientIp, userAgent);
  }

  private validHostCookie(headers: Headers, host: string, clientIp: string, userAgent: string): boolean {
    const token = readCookie(headers, HOST_COOKIE);
    return !!token && this.verifyToken(token, "host", clientIp, userAgent, { host });
  }

  private signToken(kind: Token["kind"], clientIp: string, userAgent: string, options: { host?: string; origin?: string; ttl?: number } = {}): string {
    const payload: Token = {
      kind,
      ip: hash(clientIp),
      ua: hash(userAgent),
      exp: Math.floor(Date.now() / 1000) + (options.ttl ?? COOKIE_TTL_SECONDS),
      ...(options.host ? { host: options.host } : {}),
      ...(options.origin ? { origin: options.origin } : {})
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${hmac(body, this.config.cookieSecret)}`;
  }

  private verifyToken(raw: string, kind: Token["kind"], clientIp: string, userAgent: string, options: { host?: string; origin?: string } = {}): boolean {
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
      && (!options.host || token.host === options.host)
      && (!options.origin || token.origin === options.origin);
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

  private async recordIpValidation(returnTo: string, clientIp: string, userAgent: string): Promise<boolean> {
    const target = new URL(returnTo);
    const tunnel = await prisma.tunnel.findUnique({
      where: { subdomain: target.hostname.split(".")[0] ?? "" },
      select: { id: true, validation: true }
    });
    if (tunnel?.validation !== "ip") return false;

    await prisma.visitorValidation.create({
      data: {
        tunnelId: tunnel.id,
        visitorIpHash: hash(clientIp),
        userAgentHash: hash(userAgent),
        validationCookieHash: hash(this.signToken("host", clientIp, userAgent, { host: target.hostname })),
        expiresAt: new Date(Date.now() + COOKIE_TTL_SECONDS * 1000)
      }
    });
    return true;
  }

  private verificationUrl(returnTo: string): URL {
    const url = new URL(`https://${this.config.verificationHost}/`);
    url.searchParams.set("return", returnTo);
    return url;
  }

  private readEmbeddedState(url: URL, returnTo: string, clientIp: string, userAgent: string): EmbeddedState | null | undefined {
    const rawOrigin = url.searchParams.get("embed_origin");
    const token = url.searchParams.get("embed_token");
    const rawBrowserReturn = url.searchParams.get("browser_return");
    if (!rawOrigin && !token && !rawBrowserReturn) return undefined;
    if (!rawOrigin || !token) return null;

    let origin: string;
    let browserReturn: URL | undefined;
    try {
      const parsedOrigin = new URL(rawOrigin);
      if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== rawOrigin) return null;
      origin = parsedOrigin.origin;
      if (rawBrowserReturn) {
        browserReturn = new URL(rawBrowserReturn);
        if (browserReturn.protocol !== "https:" || browserReturn.origin !== origin) return null;
      }
    } catch {
      return null;
    }

    const target = new URL(returnTo);
    if (!this.verifyToken(token, "embed", clientIp, userAgent, { host: target.hostname, origin })) return null;
    return { origin, token, ...(browserReturn ? { browserReturn: browserReturn.toString() } : {}) };
  }

  private verificationPage(returnTo: string, embedded?: EmbeddedState, error?: string): Response {
    const escapedReturn = escapeHtml(returnTo);
    const pageUrl = this.verificationUrl(returnTo);
    if (embedded) {
      pageUrl.searchParams.set("embed_origin", embedded.origin);
      pageUrl.searchParams.set("embed_token", embedded.token);
      if (embedded.browserReturn) pageUrl.searchParams.set("browser_return", embedded.browserReturn);
    }
    const escapedPageUrl = escapeHtml(pageUrl.toString());
    const takeover = embedded && !embedded.browserReturn
      ? `<script>
{
  const form=document.getElementById("verification-form");
  const currentUrl=new URL(window.location.href);
  const verificationUrl=new URL(form.action);
  if(currentUrl.origin===form.dataset.embeddedOrigin&&currentUrl.origin!==verificationUrl.origin){
    verificationUrl.searchParams.set("browser_return",currentUrl.href);
    window.top.location.href=verificationUrl.href;
  }
}
</script>`
      : "";
    const widget = this.config.turnstileSiteKey
      ? `<div id="turnstile-widget" data-sitekey="${escapeHtml(this.config.turnstileSiteKey)}"></div>
<script>
function turnstileDone(){document.getElementById("continue").disabled=false}
function turnstileReset(){document.getElementById("continue").disabled=true}
function turnstileReady(){
  const widget=document.getElementById("turnstile-widget");
  window.turnstile.render(widget,{sitekey:widget.dataset.sitekey,size:window.innerWidth<400?"compact":"flexible",callback:turnstileDone,"expired-callback":turnstileReset,"error-callback":turnstileReset});
}
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=turnstileReady&render=explicit" async defer></script>`
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
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: clamp(8px, 4vw, 24px); background: radial-gradient(circle at top, #3b0c13 0, #120506 46%, #080203 100%); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(560px, 100%); min-width: 0; overflow-wrap: anywhere; border: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,52,76,.14), rgba(255,255,255,.02)), var(--panel); border-radius: 12px; box-shadow: 0 28px 90px rgba(0,0,0,.5); padding: clamp(16px, 5vw, 30px); }
    .brand { color: var(--danger2); font-weight: 900; letter-spacing: .1em; text-transform: uppercase; font-size: 12px; }
    h1 { margin: 18px 0 0; font-size: clamp(34px, 7vw, 62px); line-height: .95; letter-spacing: 0; }
    p { margin: 18px 0 0; color: var(--muted); font-size: 18px; line-height: 1.45; }
    .notice { border: 1px solid var(--danger); background: rgba(255,52,76,.12); padding: 16px; border-radius: 8px; margin-top: 22px; font-weight: 800; }
    form { margin-top: 24px; display: grid; gap: 18px; }
    #turnstile-widget { justify-self: center; max-width: 100%; }
    button { width: 100%; min-width: 0; height: 50px; border: 0; border-radius: 8px; background: var(--danger); color: white; font-weight: 900; font-size: 15px; cursor: pointer; }
    button:hover { background: #e6273d; }
    button:disabled { opacity: .5; cursor: not-allowed; }
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
    <form id="verification-form" method="post" action="${escapedPageUrl}"${embedded ? ` data-embedded-origin="${escapeHtml(embedded.origin)}"` : ""}>
      ${takeover}
      <input type="hidden" name="return" value="${escapedReturn}">
      ${widget}
      <button id="continue" type="submit"${this.config.turnstileSiteKey ? " disabled" : ""}>I expected this tunnel</button>
    </form>
    <small>Continuing verifies this browser and IP for a short time.</small>
  </main>
</body>
</html>`, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "content-security-policy": "frame-ancestors 'none'",
        "x-frame-options": "DENY"
      }
    });
  }
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function invalidResponse(message: string): Response {
  return new Response(message, { status: 400, headers: { "cache-control": "no-store" } });
}

function embeddedOrigin(raw: string | null, verificationHost: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname !== verificationHost ? url.origin : undefined;
  } catch {
    return undefined;
  }
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

export function hash(value: string): string {
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
