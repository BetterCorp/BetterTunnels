import {
  type ApiAuthRequirement,
  type CacheHints
} from "@betterportal/framework";

export const viewId = "better-tunnels.landing";
export const title = "Development Tunnels";
export const description = "Public landing page for BetterTunnels.";

export const auth: ApiAuthRequirement = {
  required: false,
  permissions: []
};

export const cacheHints: CacheHints = {
  ttlSeconds: 60,
  varyBy: ["accept", "x-bp-tenant-id", "x-bp-app-id"]
};
