import * as av from "anyvali";
import type { Infer } from "anyvali";
import {
  type ApiAuthRequirement,
  type CacheHints
} from "@betterportal/framework";

export const viewId = "better-tunnels.landing";
export const title = "BetterTunnels";
export const description = "Public landing page for BetterTunnels.";

export const auth: ApiAuthRequirement = {
  required: false,
  permissions: []
};

export const cacheHints: CacheHints = {
  ttlSeconds: 60,
  varyBy: ["accept", "x-bp-tenant-id", "x-bp-app-id"]
};

export const ResponseSchema = av.object({
  product: av.string(),
  domain: av.string(),
  connectHost: av.string(),
  webHost: av.string(),
  logoUrl: av.string(),
  markUrl: av.string(),
  faviconUrl: av.string(),
  cliInstall: av.array(av.string()),
  highlights: av.array(av.object({
    title: av.string(),
    body: av.string()
  }, { unknownKeys: "strip" })),
  limits: av.array(av.string())
}, { unknownKeys: "strip" });
export type ResponseData = Infer<typeof ResponseSchema>;
