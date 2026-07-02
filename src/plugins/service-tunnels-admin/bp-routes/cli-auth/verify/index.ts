import * as av from "anyvali";
import type { Infer } from "anyvali";
import {
  type ApiAuthRequirement,
  type CacheHints
} from "@betterportal/framework";

export const viewId = "better-tunnels.cli-auth.verify";
export const title = "BetterTunnels CLI Authentication";
export const description = "Approves a pending BetterTunnels CLI login session.";

export const auth: ApiAuthRequirement = {
  required: true,
  permissions: []
};

export const cacheHints: CacheHints = {
  ttlSeconds: 0,
  varyBy: ["accept", "authorization", "x-bp-tenant-id", "x-bp-app-id"]
};

export const QuerySchema = av.object({
  session: av.string().minLength(1),
  key: av.string().minLength(1)
}, { unknownKeys: "strip" });

export const ResponseSchema = av.object({
  status: av.string(),
  message: av.string()
}, { unknownKeys: "strip" });
export type ResponseData = Infer<typeof ResponseSchema>;
