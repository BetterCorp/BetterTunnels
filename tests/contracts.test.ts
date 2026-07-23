import test from "node:test";
import assert from "node:assert/strict";
import { buildSubdomain, buildTunnelSubdomain, normalizeHostPart } from "../src/plugins/service-tunnels-client/ids.js";
import { tunnelStatusAfterDisconnect } from "../src/plugins/service-tunnels-client/registry.js";
import { TunnelCreateSchema } from "../src/plugins/service-tunnels-client/schemas.js";
import { buildStreamingProxyResponse, tunnelUnavailable, verificationFailureResponse } from "../src/plugins/service-tunnels-proxy/http.js";
import { normalizeIpRange } from "../src/auth.js";
import { createVerificationFlow } from "../src/plugins/service-tunnels-proxy/verification.js";
import { registry } from "../src/plugins/service-tunnels-admin/.bp-generated/registry.js";
import { render as renderDashboard } from "../src/plugins/service-tunnels-admin/bp-routes/dashboard/_theme.bootstrap1/GET.js";

test("normalizes tunnel hostnames", () => {
  assert.equal(normalizeHostPart("127.0.0.1"), "127-0-0-1");
  assert.equal(buildSubdomain("abc123", 3300, "127.0.0.1"), "abc123-port3300-127-0-0-1");
  assert.equal(buildTunnelSubdomain("abc123", 3300, "203.0.113.9"), "abc123-port3300-203-0-113-9");
});

test("validates tunnel creation input with AnyVali", () => {
  const input = TunnelCreateSchema.parse({
    sessionId: "s1",
    targetPort: 3300
  });

  assert.equal(input.targetHost, "127.0.0.1");
  assert.equal(input.authenticated, false);
});

test("normalizes auth token IP ranges", () => {
  assert.deepEqual(normalizeIpRange("203.0.113.42"), {
    family: "ipv4",
    cidr: "203.0.113.0/24"
  });
  assert.deepEqual(normalizeIpRange("2001:db8:abcd:12:1111:2222:3333:4444"), {
    family: "ipv6",
    cidr: "2001:0db8:abcd:0012:0000:0000:0000:0000/64"
  });
  assert.equal(normalizeIpRange("unknown"), undefined);
});

test("classifies tunnel disconnects at expiry", () => {
  const expiresAt = new Date("2026-07-12T12:00:00Z");
  assert.equal(tunnelStatusAfterDisconnect(expiresAt, new Date("2026-07-12T11:59:59Z")), "disconnected");
  assert.equal(tunnelStatusAfterDisconnect(expiresAt, expiresAt), "expired");
});

test("negotiates unavailable tunnel responses", async () => {
  const browser = tunnelUnavailable(new Headers({
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
  }));
  assert.equal(browser.status, 503);
  assert.equal(browser.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await browser.text(), /Development tunnel unavailable/);

  const json = tunnelUnavailable(new Headers({ accept: "application/json" }));
  assert.equal(json.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal((await json.json() as { error: string }).error, "tunnel_unavailable");

  const xml = tunnelUnavailable(new Headers({ accept: "application/xml" }));
  assert.equal(xml.headers.get("content-type"), "application/xml; charset=utf-8");
  assert.match(await xml.text(), /<code>tunnel_unavailable<\/code>/);

  const text = tunnelUnavailable(new Headers({ accept: "text/plain" }));
  assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(await text.text(), /not available right now/);
});

test("streams proxy response chunks before completion", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    }
  });
  const response = buildStreamingProxyResponse(stream, 200, { "content-type": "text/event-stream" });
  const reader = response.body!.getReader();
  controller.enqueue(new TextEncoder().encode("data: one\n\n"));

  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(new TextDecoder().decode(first.value), "data: one\n\n");
  controller.close();
  assert.equal((await reader.read()).done, true);
});

test("gates Turnstile submission and accepts recorded IP validation", async () => {
  const flow = createVerificationFlow({
    domain: "tunnels.example.test",
    verificationHost: "verify.tunnels.example.test",
    cookieSecret: "test-secret",
    turnstileSiteKey: "test-site-key"
  });
  const target = new URL("https://demo.tunnels.example.test/unavailable");
  const verifyUrl = new URL("https://verify.tunnels.example.test/");
  verifyUrl.searchParams.set("return", target.toString());
  const page = await flow.handleVerificationHost(
    { req: new Request(verifyUrl) } as never,
    verifyUrl,
    "203.0.113.42",
    "Test Browser"
  );
  const html = await page.text();

  assert.match(html, /id="continue" type="submit" disabled/);
  assert.match(html, /render=explicit/);
  assert.match(html, /id="turnstile-widget"/);
  assert.match(html, /window\.turnstile\.render/);
  assert.doesNotMatch(html, /id="turnstile"/);
  assert.match(html, /window\.innerWidth<400\?"compact":"flexible"/);
  assert.match(html, /"expired-callback":turnstileReset/);
  assert.match(html, /action="https:\/\/verify\.tunnels\.example\.test\/\?return=/);
  assert.doesNotMatch(html, /window\.top\.location\.href/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("access-control-allow-origin"), "*");
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const event = { req: new Request(target) } as never;
  assert.equal(await flow.enforce(event, target, "203.0.113.42", "Test Browser", "cookie", false, true), undefined);
  assert.equal(await flow.enforce(event, target, "203.0.113.42", "Test Browser", "ip", true), undefined);

  const redirect = await flow.enforce(event, target, "203.0.113.42", "Test Browser", "ip", false);
  assert.equal(redirect?.status, 302);
  assert.match(redirect?.headers.get("location") ?? "", /^https:\/\/verify\.tunnels\.example\.test\//);

  assert.equal(redirect?.headers.get("cache-control"), "no-store");

  const embeddedRequest = new Request(target, {
    headers: { origin: "https://app.example.test" }
  });
  const embeddedRedirect = await flow.enforce(
    { req: embeddedRequest } as never,
    target,
    "203.0.113.42",
    "Test Browser",
    "ip",
    false
  );
  const embeddedUrl = new URL(embeddedRedirect?.headers.get("location") ?? "");
  assert.equal(embeddedUrl.searchParams.get("embed_origin"), "https://app.example.test");

  const embeddedPage = await flow.handleVerificationHost(
    { req: new Request(embeddedUrl) } as never,
    embeddedUrl,
    "203.0.113.42",
    "Test Browser"
  );
  const embeddedHtml = await embeddedPage.text();
  assert.match(embeddedHtml, /window\.top\.location\.href=verificationUrl\.href/);
  assert.match(embeddedHtml, /verificationUrl\.searchParams\.set\("browser_return",currentUrl\.href\)/);

  const browserReturnUrl = new URL(embeddedUrl);
  browserReturnUrl.searchParams.set("browser_return", "https://app.example.test/dashboard");
  const browserReturnPage = await flow.handleVerificationHost(
    { req: new Request(browserReturnUrl) } as never,
    browserReturnUrl,
    "203.0.113.42",
    "Test Browser"
  );
  assert.equal(browserReturnPage.status, 200);
  assert.doesNotMatch(await browserReturnPage.text(), /window\.top\.location\.href/);

  const invalidBrowserReturnUrl = new URL(embeddedUrl);
  invalidBrowserReturnUrl.searchParams.set("browser_return", "https://evil.example.test/");
  const invalidBrowserReturn = await flow.handleVerificationHost(
    { req: new Request(invalidBrowserReturnUrl) } as never,
    invalidBrowserReturnUrl,
    "203.0.113.42",
    "Test Browser"
  );
  assert.equal(invalidBrowserReturn.status, 400);
  assert.equal(invalidBrowserReturn.headers.get("cache-control"), "no-store");

  const cookieRedirect = await flow.enforce(
    { req: embeddedRequest } as never,
    target,
    "203.0.113.42",
    "Test Browser",
    "cookie",
    false
  );
  assert.doesNotMatch(cookieRedirect?.headers.get("location") ?? "", /embed_origin/);

  const preflight = verificationFailureResponse("OPTIONS", embeddedRedirect!);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "*");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "*");
  assert.equal(preflight.headers.get("access-control-max-age"), "0");
  assert.equal(preflight.headers.get("cache-control"), "no-store");
  assert.equal(preflight.headers.get("location"), null);
  const guardedRedirect = verificationFailureResponse("GET", embeddedRedirect!);
  assert.equal(guardedRedirect, embeddedRedirect);
  assert.equal(guardedRedirect.status, 302);
  assert.equal(guardedRedirect.headers.get("access-control-allow-origin"), "*");
  assert.equal(guardedRedirect.headers.get("access-control-allow-methods"), "*");
  assert.equal(guardedRedirect.headers.get("access-control-allow-headers"), "*");
  assert.equal(guardedRedirect.headers.get("access-control-max-age"), "0");
  assert.equal(guardedRedirect.headers.get("cache-control"), "no-store");
  assert.equal(guardedRedirect.headers.get("location"), embeddedUrl.toString());
});

test("registers the dashboard as a native SSE view", () => {
  const route = registry.routes.find((candidate) => candidate.viewId === "better-tunnels.dashboard");
  assert.ok(route?.sse);
  assert.equal(typeof route.sse.handler, "function");

  const fragment = route.themeRenderers.bootstrap1?.fragments.find(
    (candidate) => candidate.rendererId === "body.live"
  );
  assert.equal(typeof fragment?.sseRender, "function");

  const html = String(renderDashboard({
    activeTunnels: 1,
    requests: 2,
    bytesIn: 3,
    bytesOut: 4,
    tunnels: [{
      id: "t1",
      subdomain: "demo",
      publicUrl: "https://demo.tunnels.example.test",
      target: "127.0.0.1:3000",
      validation: "ip",
      expiresAt: "2026-07-14T00:00:00.000Z",
      requests: 2,
      bytesIn: 3,
      bytesOut: 4
    }]
  }));
  assert.match(html, /hx-ext="sse"/);
  assert.match(html, /\/dashboard\/__sse\?_f=body\.live/);
  assert.match(html, /href="https:\/\/demo\.tunnels\.example\.test"/);
  assert.match(html, /IP validation/);
  assert.match(html, /data-expires-at=/);
  assert.match(html, /setInterval\(window\.updateTunnelCountdowns, 1000\)/);
  assert.match(html, /Expires in/);
});

test("uses unique descriptive view titles", () => {
  const titles = registry.routes.map((route) => route.title);
  assert.equal(new Set(titles).size, titles.length);
  assert.deepEqual(Object.fromEntries(registry.routes.map((route) => [route.path, route.title])), {
    "/cli-auth/verify": "CLI Authentication",
    "/dashboard": "Tunnel Dashboard",
    "/downloads": "CLI Downloads",
    "/landing": "Development Tunnels",
    "/tunnels": "Tunnel Sessions"
  });
});
