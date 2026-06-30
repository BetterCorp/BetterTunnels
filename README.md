# BetterTunnels

HTTP/HTTPS development tunnels using BSB, H3, AnyVali, websocket clients, Prisma, and PostgreSQL 18.

## Dev Setup

```powershell
npm install
copy .env.example .env
npm run prisma:generate
npm run build
```

Start PostgreSQL 18 with the included compose file when Docker is available:

```powershell
docker compose up -d postgres
npm run prisma:migrate
```

Run the server:

```powershell
npm run dev
```

Server startup goes through BSB. Do not start a standalone `src/server.ts`.

Run a tunnel:

```powershell
npm run cli -- http 3300
```

## Notes

- Default domain: `tunnels.betterportal.dev`.
- Anonymous configured prefixes are ignored.
- Authenticated prefix handling is designed but auth is not in the first runtime slice.
- The H3/WS runtime is owned by the `service-tunnel-web` BSB plugin.
- The current Node CLI is a development client. Final CLI should likely be Rust or Go for cross-OS static builds.

## Docker

Build the BSB runtime image with this plugin preloaded:

```powershell
docker build -t better-tunnels:dev .
```

Run it with a production `DATABASE_URL`:

```powershell
docker run --rm -p 8080:8080 -p 8081:8081 -e DATABASE_URL="postgresql://..." better-tunnels:dev
```

## Swarm Deploy

On the server, build local images, run migrations, then deploy the stack:

```bash
docker swarm init
docker build -t bettertunnels-app:latest .
docker build -t bettertunnels-migrate:latest --target build .
docker build -t bettertunnels-caddy:latest -f Dockerfile.caddy .
docker stack deploy -c docker-stack.yml bettertunnels
```

`app` runs two replicas with `start-first` rolling updates. Caddy and Postgres are singletons on this one-node swarm. The stack reuses the original Compose volumes by external name.
