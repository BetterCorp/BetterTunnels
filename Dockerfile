# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build?schema=public

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

RUN npm ci
RUN npm run build
RUN cp -R src/generated lib/generated

FROM build AS prod-deps

RUN npm prune --omit=dev

FROM betterweb/service-base:node-latest AS runtime

ENV NODE_ENV=production
ENV BSB_CONTAINER=true
ENV BSB_LIVE=true
ENV BSB_PLUGIN_DIRS=/opt/bsb-plugins
ENV BSB_CONFIG_FILE=/home/bsb/sec-config.yaml

USER root

RUN mkdir -p /opt/bsb-plugins/better-tunnels/0/1/0 /home/bsb/bp
RUN printf '{"private":true,"type":"module"}\n' > /opt/bsb-plugins/package.json

COPY --from=build /app/package.json /opt/bsb-plugins/better-tunnels/0/1/0/package.json
COPY --from=build /app/package-lock.json /opt/bsb-plugins/better-tunnels/0/1/0/package-lock.json
COPY --from=build /app/lib /opt/bsb-plugins/better-tunnels/0/1/0/lib
COPY --from=prod-deps /app/node_modules /opt/bsb-plugins/better-tunnels/0/1/0/node_modules
COPY sec-config.yaml /home/bsb/sec-config.yaml

RUN chown -R node:node /opt/bsb-plugins /home/bsb/sec-config.yaml /home/bsb/bp
