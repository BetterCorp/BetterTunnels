# BetterTunnels SPEC

## Goal

Build an HTTP/HTTPS-only tunnel service for development traffic.

The platform has two moving pieces:

- Server: accepts public HTTP/HTTPS traffic, validates visitors when needed, rate-limits, and routes requests to connected clients.
- Client CLI: creates tunnels from local `host:port` targets and keeps a websocket control/data connection open to the server.

Long-term service split:

1. Front-facing tunnel service.
2. Client API/websocket service.
3. BetterPortal management UI/API service.

Non-goals:

- Raw TCP tunnels.
- UDP tunnels.
- SSH/VNC/database protocol tunneling.
- General-purpose VPN or private network mesh.

## Product Shape

Example CLI flow:

```powershell
btunnel http 3300
btunnel http 127.0.0.1:3210
btunnel http 3000 --auth
```

Example public URLs:

```text
https://a1b2c3-port3300-127-0-0-1.tunnels.betterportal.dev
https://x9y8z7-port3210-devhost.tunnels.betterportal.dev
```

The tunnel creator should bypass visitor verification from the same IP used to create or bring up the tunnel. Other visitors see a development-tunnel verification page first.

## Framework

Use `better-service-base` as the service foundation.

Core plugins:

- `h3-web`: public HTTP/HTTPS edge, visitor verification, rate limiting, error pages.
- `h3-client-api`: tunnel creation, client websocket control plane, request routing, stream handling.

Use BSB's built-in streaming framework for request/response bodies. Do not hand-roll stream buffering except for tiny metadata frames.

All data entering or leaving any service boundary must be validated with AnyVali.

AnyVali validation applies to:

- Public HTTP requests.
- Client API requests.
- Websocket frames.
- CLI config files.
- Database DTOs where data crosses service/module boundaries.
- BetterPortal management APIs when added later.

## Transport

Public side:

- HTTP/1.1 and HTTP/2 required.
- HTTP/3 desirable if the runtime/proxy supports it cleanly.
- HTTPS required for public tunnel hostnames.
- BetterTunnels is public internet-facing infrastructure, not hidden behind Cloudflare proxying.
- Default public domain is `tunnels.betterportal.dev`.
- Public tunnel hostnames use `*.tunnels.betterportal.dev`.

Client side:

- Websocket connection from CLI to server.
- One websocket per active tunnel for MVP.
- A CLI process may open multiple tunnel websockets from one `.bettertunnel` config.
- Requests are multiplexed over the tunnel websocket using request IDs.
- Each proxied request carries method, path, query, headers, a bounded body, and a response stream.
- Client sends heartbeat every 30 seconds.
- Two missed heartbeats force disconnect and session cleanup.
- Request bodies are buffered up to the configured request-body limit; response headers and body chunks stream immediately.
- The total request timeout applies while waiting for response headers; SSE drops that total cap after headers and remains subject to the idle timeout.
- If the client disconnects mid-request, return `502`.
- Idle data timeout: 30 seconds for anonymous tunnels, 60 seconds for authenticated tunnels.
- Total request timeout: 60 seconds for anonymous tunnels, 5 minutes for authenticated tunnels.

Minimum frame types:

```text
client.register
client.heartbeat
tunnel.create
tunnel.close
request.start
request.body
request.end
request.cancel
response.start
response.body
response.end
error
```

## Wildcard Domains And TLS

Wildcard certs are practical with ACME DNS-01.

Preferred path:

- ACME DNS-01 challenge.
- Wildcard cert for `*.tunnels.betterportal.dev`.
- Optional separate cert for apex/admin hostnames.

HTTP-01 cannot issue wildcard certificates, so DNS-01 is required.

## Tunnel Lifecycle

Tunnel states:

```text
created -> active -> draining -> closed
created -> expired
active -> disconnected -> reconnecting -> active
active -> disconnected -> expired
```

Unauthenticated tunnels:

- Max lifetime: 6 hours.
- Lower request rate limit.
- Lower bandwidth/data transfer limit.
- Random subdomain only.
- Creator IP bypasses visitor verification while the tunnel session is active.

Registered tunnels:

- Higher limits.
- Longer sessions.
- Stable random subdomain for the same account/port/IP tuple within a 24 hour window.
- Authenticated users may set the 6 character prefix.
- Config-defined prefixes let a repo spin up stable preconfigured tunnels quickly.
- Turnstile only on tunnel creation/start unless risk checks trigger.

Prefix rule:

- Anonymous tunnels always ignore configured prefixes.
- Authenticated tunnels may use configured prefixes.
- If an authenticated configured prefix is unavailable or invalid, fail clearly instead of silently changing it.

## Visitor Verification

Use Cloudflare Turnstile for first access from a visitor IP that is not the tunnel creator IP.

Turnstile hostnames cannot cover arbitrary wildcard tunnel hosts, so verification happens on a fixed verification host:

```text
verify.tunnels.betterportal.dev
```

Client websocket traffic uses:

```text
connect.tunnels.betterportal.dev
```

Verification policy:

- Creator IP: bypass while tunnel session is active.
- Free/anonymous tunnel visitor: redirect to `verify.tunnels.betterportal.dev`, show a server-controlled warning page with a 15 second wait, then Turnstile, then redirect back.
- Different visitor IP: validate independently.
- Visitor cookie must match the stored IP hash and user agent hash. Mismatch triggers validation again.
- Registered tunnel visitor: redirect to verification when needed; if the verification host already has a valid account/session cookie, auto-issue the tunnel validation and redirect back.

Verification redirect flow:

```text
original tunnel URL
-> verify.tunnels.betterportal.dev?challenge=...
-> Turnstile / existing verification session
-> original tunnel URL with signed challenge response
-> server sets a tunnel-scoped validation cookie
```

API callers may see multiple redirects on the first request. That is acceptable for MVP.

Verification state should be stored server-side with:

```text
tunnel_id
visitor_ip_hash
validated_at
expires_at
user_agent_hash
validation_cookie_hash
```

Do not store raw visitor IPs unless needed for abuse handling.

Anonymous CLI users still get a virtual account:

- First CLI use creates or reuses a local API key.
- The account is marked `anonymous`.
- Anonymous tunnels, sessions, limits, abuse reports, and verification history are linked to that virtual account.
- Promotion to a registered account can happen later without losing local tunnel history.

The warning page must clearly state:

- This is a development tunnel.
- The site is not Microsoft, Google, a bank, or any other implied third party.
- The visitor should only continue if they expected a development tunnel.
- A report-abuse action is available.

## Abuse Controls

Per tunnel:

- Requests per minute.
- Concurrent requests.
- Response body bytes per minute.
- Total bytes over lifetime.
- Max request body size.
- Max response body size for anonymous tunnels.

Per account/session:

- Active tunnel count.
- New tunnel creation rate.
- Reserved subdomain count.

Per source IP:

- Verification attempts.
- Failed Turnstile attempts.
- Request rate before verification.

Do not block phishing-looking paths by default. Development apps often legitimately contain login, OAuth, and test payment flows.

## Error Pages

Provide Cloudflare-style diagnostic pages with four layers:

```text
Visitor -> BetterTunnels Edge -> Tunnel Client -> Local App
```

Common statuses:

- `404`: no such tunnel/subdomain.
- `410`: tunnel expired.
- `429`: rate limited.
- `502`: tunnel client disconnected or local app refused connection.
- `504`: local app timed out.

The page should explain that this is a development tunnel and identify which layer failed without leaking private local addresses.

## Routing

Incoming request routing key:

```text
Host header -> tunnel subdomain -> active tunnel_id -> connected client session
```

Optional subdomain hints:

```text
{6chars}-port{port}-{ip-or-host}.domain
a1b2c3-port3300-127-0-0-1.domain
x9y8z7-port3210-devhost.domain
```

Subdomain rules:

- Anonymous tunnels always get a fresh random 6 character prefix.
- Authenticated tunnels reuse the same 6 character prefix for the same account, port, and IP/host tuple for up to 24 hours.
- Custom subdomains are not part of the MVP.
- The database mapping is authoritative.

## Persistence

Use PostgreSQL 18 for MVP data storage.

Use Prisma ORM for schema, migrations, and normal CRUD.

Use raw SQL only when Prisma is a bad fit, such as atomic usage counter increments or cleanup jobs.

Minimum tables:

```text
accounts
client_sessions
tunnels
tunnel_names
visitor_validations
usage_counters
audit_events
```

Anonymous users can be represented as ephemeral accounts or session-scoped identities.

Persistence stores durable/control data. Active websocket handles and in-flight request streams stay in process memory.

## CLI

The MVP may use a Node development CLI while the protocol settles.

Final CLI should likely be Rust or Go so releases can compile cleanly for Windows, macOS, and Linux.

Commands:

```powershell
btunnel login
btunnel logout
btunnel http <port>
btunnel http <host:port>
btunnel list
btunnel close <name-or-id>
btunnel status
```

The CLI should:

- Print public URL.
- Keep running while tunnels are active.
- Reconnect automatically.
- Re-register active tunnels after reconnect.
- Show request logs, response statuses, tunnel TTLs, and local target errors during the session.
- Support client-side `Host` header override.
- Read defaults from `.bettertunnel`.

Example `.bettertunnel`:

```toml
[[tunnels]]
port = 3300
prefix = "webdv1"

[[tunnels]]
host = "127.0.0.1"
port = 3210
prefix = "api001"
host_header = "localhost:3210"
```

## Admin

No admin portal in MVP.

Future admin/BP integration can cover:

- Active tunnels.
- Connected clients.
- Traffic usage.
- Rate-limit events.
- Verification failures.
- Abuse reports.

## Security

Required:

- Validate and normalize forwarded headers.
- Strip hop-by-hop headers.
- Add `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`.
- Prevent request smuggling with strict header/body parsing.
- Enforce max header size and body limits.
- Anonymous tunnels only allow a conservative header allowlist.
- Authenticated tunnels allow a broader header set with strict size limits.
- Anonymous tunnels strip incoming and outgoing `Cookie` / `Set-Cookie` headers.
- Tunnel responses cannot set broad domain cookies such as `.tunnels.betterportal.dev`.
- Tunnel responses cannot set cookies for sibling tunnel subdomains.
- BetterTunnels verification cookies are server-owned and may intentionally span verification flows.
- Preferred validation cookie model: verification host proves Turnstile/account state, then the original tunnel host sets a narrow, signed, tunnel-scoped cookie from a challenge response.
- Use signed tunnel/client session tokens.
- Hash visitor IPs at rest.

Forwarding rule:

The local app sees normal proxied HTTP requests. It must not receive server-only auth, Turnstile, or internal routing headers.

## Scaling

Single-node first.

Multi-container later:

- Shared DB for tunnel/session state.
- Shared pub/sub for routing control messages.
- Sticky websocket sessions or a stream router that can reach the owning client connection.
- Stateless public edge workers can forward to the node that owns the client session.
- Use BSB/ABS logging, traces, spans, and metrics for operational visibility.

Do not build distributed routing until single-node behavior is stable.

## Engineering Rules

Zero duct tape.

If something is not working:

1. Stop.
2. Analyze the actual failure.
3. Write the resolution path.
4. Implement the fix only after the cause is understood.

Do not force broken behavior to pass with retries, sleeps, hidden fallbacks, duplicated state, schema bypasses, broad catches, or one-off patches.

If the cause cannot be found quickly, stop and ask instead of layering workaround code.

## Open Questions

- Whether account auth lives inside BetterTunnels or delegates to BetterPortal.
- Whether multi-tunnel CLI should keep one websocket per tunnel forever or later add a shared control socket.

## Future BetterPortal Integration

BetterPortal lives separately at:

```text
BetterPortal integration lives in the BetterPortal repository and is wired through the BP service plugin.
```

Future integration ideas:

- BetterPortal cover/integration plugin.
- Let BP services expose development endpoints through BetterTunnels.
- Tie dev tunnels into a dev BP site.
- Allow externally accessible service paths or names managed from BP.
- Centralize account, team, billing, and service deployment flows in BP.

Do not build this in the MVP.

## MVP

1. Server accepts wildcard HTTPS requests.
2. CLI opens websocket and registers one local HTTP target.
3. Server routes public request to CLI and streams response back.
4. Unknown visitor IP sees Turnstile first.
5. Anonymous tunnel expires after 6 hours.
6. Basic limits: request rate, concurrent requests, max body size.
7. Diagnostic pages for no tunnel, disconnected client, local app failure.

## Development Workflow

Build order:

1. Create the BSB service shell.
2. Add H3 runtime inside BSB service plugins only.
3. Add `h3-client-api` with websocket tunnel registration.
4. Add the CLI command that opens one websocket for one local port.
5. Proxy one HTTP request end-to-end with streamed response body.
6. Add request body streaming.
7. Add wildcard host routing for `*.tunnels.betterportal.dev`.
8. Add Turnstile/warning validation.
9. Add limits and timeout enforcement.
10. Add diagnostic pages.
11. Add `.bettertunnel` multi-tunnel startup.

Server rule:

- No standalone server entrypoint.
- Server runtime starts through BSB plugin lifecycle.
- Client CLI may be standalone.

MVP local development flow:

```powershell
btunnel http 3300
```

Expected output:

```text
Tunnel active
Local:  http://127.0.0.1:3300
Public: https://a1b2c3-port3300-127-0-0-1.tunnels.betterportal.dev
TTL:    6h
```

MVP repo config flow:

```powershell
btunnel up
```

Reads `.bettertunnel`, opens one websocket per tunnel, and prints all active URLs.

Anonymous `.bettertunnel` behavior:

- `prefix` is ignored.
- Fresh random 6 character prefix every session.
- 6 hour TTL.

Authenticated `.bettertunnel` behavior:

- `prefix` is honored if valid and available.
- Same prefix can be reused for fast repo startup.
- Higher limits and longer timeouts apply.
- Account plan controls feature flags such as IP-based verification, verification bypass, custom prefixes, limits, and retention.
- Paid/registered users can verify trusted public IPs for automation where browser cookies are not practical.
- Successful CLI authentication trusts only a hashed IPv4 `/24` or IPv6 `/64` range for that tenant/user.
- Trusted ranges expire one year after last use; an unknown range denies the token and requires re-authentication before it is linked.
- Tunnel commands automatically enter the browser login flow when saved authentication is rejected.

CLI self-hosting behavior:

- `btunnel host .` can serve a static directory and expose it publicly without a separate local server. It picks a free local port automatically; `--port <port>` overrides, and startup fails fast if that port is unavailable (no tunnel is started).
- `btunnel host --dev --port <port> <command...>` can run a local dev server and expose its selected port. `--port` is required because the dev command, not the CLI, owns the listener.
- `btunnel up` reads `.bettertunnel.json`; each tunnel entry can optionally orchestrate its own service:
  - `btunnel up <prefix>` starts only the single entry whose configured `prefix` matches.
  - `btunnel up --proc` opens each entry in its own terminal window and requires at least two entries. The original terminal remains as the supervisor: it lists each window and PID, and closing or interrupting it stops all child windows.
  - `name`: label used for log prefixes and errors.
  - `run`: shell command the CLI starts and owns (`port` required; killed as a tree on exit/ctrl-c; if it exits, all services stop and `up` exits non-zero).
  - `cwd`: working directory for `run` (only valid with `run`).
  - `dir`: static directory served by the CLI (mutually exclusive with `run`; `port` optional, auto-picks a free port).
  - `health`: HTTP path polled until it returns < 400 before the tunnel connects; without it, `run` entries gate on TCP accept.
  - `ready_timeout`: readiness timeout in seconds (default 30); on timeout everything stops and `up` exits non-zero.
  - Note: `run` executes arbitrary shell commands from the repo config — same trust model as npm scripts.
- HTTP websocket upgrades from visitors should pass through to the local target as websocket connections; no path-specific config required.
- Websocket passthrough must use BSB stream/event ownership between `service-tunnels-proxy` and `service-tunnels-client`; do not emulate it with buffered request events.

Smallest useful implementation slice:

1. PostgreSQL 18.
2. Prisma schema and migrations.
3. No auth.
4. In-memory active tunnel/session registry backed by persisted tunnel rows.
5. One server process.
6. One CLI process.
7. One websocket per tunnel.
8. One proxied request at a time, then add concurrency.

Do not persist in-flight streams or websocket state.
