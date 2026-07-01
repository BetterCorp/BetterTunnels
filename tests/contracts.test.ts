import test from "node:test";
import assert from "node:assert/strict";
import { buildSubdomain, buildTunnelSubdomain, normalizeHostPart } from "../src/plugins/service-tunnel-client-api/ids.js";
import { TunnelCreateSchema } from "../src/plugins/service-tunnel-client-api/schemas.js";
import { tunnelUnavailable } from "../src/plugins/service-tunnel-web/http.js";
import { normalizeIpRange } from "../src/auth.js";

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
