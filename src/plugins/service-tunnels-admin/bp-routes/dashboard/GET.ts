import { createHandler } from "@betterportal/framework";
import { prisma } from "../../../../prisma.js";
import { ResponseSchema } from "./index.js";

export { ResponseSchema } from "./index.js";

export default createHandler(
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
