import {
  type ApiAuthRequirement,
  type CacheHints
} from "@betterportal/framework";

export const viewId = "better-tunnels.downloads";
export const title = "CLI Downloads";
export const description = "CLI download and setup commands.";

export const auth: ApiAuthRequirement = {
  required: false,
  permissions: []
};

export const cacheHints: CacheHints = {
  ttlSeconds: 60,
  varyBy: ["accept", "x-bp-tenant-id", "x-bp-app-id"]
};
