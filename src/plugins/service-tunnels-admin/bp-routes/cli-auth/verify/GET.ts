import { createHandler } from "@betterportal/framework";
import { hashSecret, verifySecret } from "../../../../../auth.js";
import { prisma } from "../../../../../prisma.js";
import { QuerySchema, ResponseSchema } from "./index.js";

export { QuerySchema, ResponseSchema } from "./index.js";

export default createHandler(
  { query: QuerySchema, response: ResponseSchema },
  async (ctx) => {
    const query = ctx.query as { session: string; key: string };
    const session = await prisma.clientAuthSession.findUnique({
      where: { id: query.session }
    });

    if (!session || session.status !== "pending" || session.expiresAt <= new Date()) {
      return { status: "invalid", message: "This CLI authentication request is no longer valid." };
    }

    if (!verifySecret(query.key, session.browserKeyHash)) {
      return { status: "invalid", message: "This CLI authentication request is no longer valid." };
    }

    const configuredAppId = typeof ctx.config?.mainAuthAppId === "string" ? ctx.config.mainAuthAppId : undefined;
    if (configuredAppId && ctx.app.id !== configuredAppId) {
      return { status: "invalid", message: "This BetterPortal app is not configured for BetterTunnels CLI authentication." };
    }

    const user = ctx.user as Record<string, unknown> | undefined;
    const subject = String(user?.sub ?? user?.subject ?? user?.id ?? "unknown");
    const email = typeof user?.email === "string" ? user.email : undefined;

    await prisma.clientAuthSession.update({
      where: { id: session.id },
      data: {
        status: "approved",
        tenantId: ctx.tenant.id,
        appId: ctx.app.id,
        bpUserSubject: subject,
        bpUserEmail: email,
        approvedAt: new Date(),
        userAgentHash: typeof ctx.headers["user-agent"] === "string" ? hashSecret(ctx.headers["user-agent"]) : session.userAgentHash
      }
    });

    return {
      status: "approved",
      message: "BetterTunnels CLI authenticated. You can close this tab."
    };
  }
);
