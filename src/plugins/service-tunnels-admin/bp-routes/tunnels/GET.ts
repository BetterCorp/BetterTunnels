import { createHandler } from "@betterportal/framework";
import { prisma } from "../../../../prisma.js";
import { ResponseSchema } from "./index.js";

export { ResponseSchema } from "./index.js";

export default createHandler(
  { response: ResponseSchema },
  async () => {
    const rows = await prisma.tunnel.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { usage: true }
    });

    return {
      active: rows.filter((row) => row.status === "active").length,
      total: rows.length,
      tunnels: rows.map((row) => ({
        id: row.id,
        subdomain: row.subdomain,
        target: `${row.targetHost}:${row.targetPort}`,
        authenticated: row.authenticated,
        status: row.status,
        ownerServerId: row.ownerServerId ?? undefined,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        requests: row.usage?.requests ?? 0,
        bytesIn: Number(row.usage?.bytesIn ?? 0n),
        bytesOut: Number(row.usage?.bytesOut ?? 0n)
      }))
    };
  }
);
