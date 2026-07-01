import * as av from "anyvali";
import type { Infer } from "anyvali";
import {
  createHandler,
  type ApiAuthRequirement,
  type CacheHints
} from "@betterportal/framework";
import { prisma } from "../../../../prisma.js";

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

export const handleGet = createHandler(
  { response: ResponseSchema },
  async () => {
    const [
      activeTunnels,
      totalTunnels,
      anonymousAccounts,
      registeredAccounts,
      usageRows,
      recentAuditEvents
    ] = await Promise.all([
      prisma.tunnel.count({ where: { status: "active" } }),
      prisma.tunnel.count(),
      prisma.account.count({ where: { plan: "anonymous" } }),
      prisma.account.count({ where: { NOT: { plan: "anonymous" } } }),
      prisma.usageCounter.findMany(),
      prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: 10 })
    ]);

    return {
      activeTunnels,
      totalTunnels,
      anonymousAccounts,
      registeredAccounts,
      requests: usageRows.reduce((sum, row) => sum + row.requests, 0),
      bytesIn: usageRows.reduce((sum, row) => sum + Number(row.bytesIn), 0),
      bytesOut: usageRows.reduce((sum, row) => sum + Number(row.bytesOut), 0),
      recentAuditEvents: recentAuditEvents.map((event) => ({
        id: event.id,
        event: event.event,
        subjectId: event.subjectId ?? undefined,
        createdAt: event.createdAt.toISOString()
      }))
    };
  }
);
