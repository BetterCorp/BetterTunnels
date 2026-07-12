import {
  type ApiAuthRequirement,
  type CacheHints
} from "@betterportal/framework";

export const viewId = "better-tunnels.cli-auth.verify";
export const title = "CLI Authentication";
export const description = "Approves a pending BetterTunnels CLI login session.";

export const auth: ApiAuthRequirement = {
  required: true,
  permissions: []
};

export const cacheHints: CacheHints = {
  ttlSeconds: 0,
  varyBy: ["accept", "authorization", "x-bp-tenant-id", "x-bp-app-id"]
};
