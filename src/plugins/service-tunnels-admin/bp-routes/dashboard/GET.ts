import * as av from "anyvali";
import type { Infer } from "anyvali";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { prisma } from "../../../../prisma.js";

const TunnelSchema = av.object({
  id: av.string(),
  subdomain: av.string(),
  publicUrl: av.optional(av.string()),
  target: av.string(),
  validation: av.string(),
  expiresAt: av.string(),
  requests: av.number(),
  bytesIn: av.number(),
  bytesOut: av.number()
});

export const DashboardSchema = av.object({
  activeTunnels: av.number(),
  requests: av.number(),
  bytesIn: av.number(),
  bytesOut: av.number(),
  tunnels: av.array(TunnelSchema)
});
export type DashboardData = Infer<typeof DashboardSchema>;
export const ResponseSchema = DashboardSchema;
export type ResponseData = DashboardData;

export async function loadDashboard(): Promise<DashboardData> {
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
      publicUrl: tunnel.publicUrl ?? undefined,
      validation: tunnel.validation,
      expiresAt: tunnel.expiresAt.toISOString(),
      requests: tunnel.usage?.requests ?? 0,
      bytesIn: Number(tunnel.usage?.bytesIn ?? 0n),
      bytesOut: Number(tunnel.usage?.bytesOut ?? 0n)
    }))
  };
}

export default createHandler({ response: ResponseSchema }, loadDashboard);
