import * as av from "anyvali";
import type { Infer } from "anyvali";
import {
  type ApiAuthRequirement,
  type CacheHints
} from "@betterportal/framework";

export const viewId = "better-tunnels.tunnels";
export const title = "BetterTunnels";
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

const TunnelRowSchema = av.object({
  id: av.string(),
  subdomain: av.string(),
  target: av.string(),
  authenticated: av.bool(),
  status: av.string(),
  ownerServerId: av.optional(av.string()),
  createdAt: av.string(),
  expiresAt: av.string(),
  requests: av.number(),
  bytesIn: av.number(),
  bytesOut: av.number()
}, { unknownKeys: "strip" });

export const ResponseSchema = av.object({
  active: av.number(),
  total: av.number(),
  tunnels: av.array(TunnelRowSchema)
}, { unknownKeys: "strip" });
export type ResponseData = Infer<typeof ResponseSchema>;
