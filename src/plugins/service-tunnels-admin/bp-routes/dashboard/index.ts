import * as av from "anyvali";
import type { Infer } from "anyvali";
import {
  type ApiAuthRequirement,
  type CacheHints
} from "@betterportal/framework";

export const viewId = "better-tunnels.dashboard";
export const title = "BetterTunnels Dashboard";
export const description = "Operational summary for BetterTunnels.";

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

export const ResponseSchema = av.object({
  activeTunnels: av.number(),
  totalTunnels: av.number(),
  anonymousAccounts: av.number(),
  registeredAccounts: av.number(),
  requests: av.number(),
  bytesIn: av.number(),
  bytesOut: av.number(),
  recentAuditEvents: av.array(av.object({
    id: av.string(),
    event: av.string(),
    subjectId: av.optional(av.string()),
    createdAt: av.string()
  }, { unknownKeys: "strip" }))
}, { unknownKeys: "strip" });
export type ResponseData = Infer<typeof ResponseSchema>;
