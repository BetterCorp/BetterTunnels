import * as av from "anyvali";
import type { Infer } from "anyvali";
import { setTimeout as delay } from "node:timers/promises";
import { createStreamHandler } from "../../.bp-generated/route-runtime.js";
import { prisma } from "../../../../prisma.js";

const TunnelSchema = av.object({
  id: av.string(),
  subdomain: av.string(),
  target: av.string(),
  authenticated: av.bool(),
  expiresAt: av.string(),
  requests: av.number(),
  bytesIn: av.number(),
  bytesOut: av.number()
}, { unknownKeys: "strip" });

export const ItemSchema = av.object({
  activeTunnels: av.number(),
  requests: av.number(),
  bytesIn: av.number(),
  bytesOut: av.number(),
  tunnels: av.array(TunnelSchema)
}, { unknownKeys: "strip" });
export type DashboardData = Infer<typeof ItemSchema>;
export type ResponseData = { items: DashboardData[] };

async function loadDashboard(): Promise<DashboardData> {
  const now = new Date();
  const [tunnels, usageRows] = await Promise.all([
    prisma.tunnel.findMany({
      where: { status: "active", expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      include: { usage: true }
    }),
    prisma.usageCounter.findMany()
  ]);

  return {
    activeTunnels: tunnels.length,
    requests: usageRows.reduce((sum, row) => sum + row.requests, 0),
    bytesIn: usageRows.reduce((sum, row) => sum + Number(row.bytesIn), 0),
    bytesOut: usageRows.reduce((sum, row) => sum + Number(row.bytesOut), 0),
    tunnels: tunnels.map((tunnel) => ({
      id: tunnel.id,
      subdomain: tunnel.subdomain,
      target: `${tunnel.targetHost}:${tunnel.targetPort}`,
      authenticated: tunnel.authenticated,
      expiresAt: tunnel.expiresAt.toISOString(),
      requests: tunnel.usage?.requests ?? 0,
      bytesIn: Number(tunnel.usage?.bytesIn ?? 0n),
      bytesOut: Number(tunnel.usage?.bytesOut ?? 0n)
    }))
  };
}

export default createStreamHandler(
  { item: ItemSchema },
  async function* ({ headers }) {
    const live = headers.accept?.includes("text/event-stream") ?? false;
    do {
      yield await loadDashboard();
      if (live) await delay(5_000);
    } while (live);
  }
);
