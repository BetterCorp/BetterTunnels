import {
  type ApiAuthRequirement,
  type CacheHints
} from "@betterportal/framework";

export const viewId = "better-tunnels.tunnels";
export const title = "Tunnel Sessions";
export const description = "Tunnel sessions, status, and recent activity.";

export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "service.betterportal.tunnels", viewId, permissions: ["read"] }
  ]
};

export const cacheHints: CacheHints = {
  ttlSeconds: 5,
  varyBy: ["accept", "authorization", "x-bp-tenant-id", "x-bp-app-id"]
};
