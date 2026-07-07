import * as av from "anyvali";
import type { Infer } from "anyvali";

export const TunnelCreateSchema = av.object({
  sessionId: av.string().minLength(1),
  targetHost: av.string().minLength(1).default("127.0.0.1"),
  targetPort: av.number(),
  clientVersion: av.optional(av.string()),
  authenticated: av.bool().default(false),
  prefix: av.optional(av.string()),
  token: av.optional(av.string())
}, { unknownKeys: "strip" });
export type TunnelCreateInput = Infer<typeof TunnelCreateSchema>;

export const ClientFrameSchema = av.object({
  type: av.string().minLength(1),
  code: av.optional(av.number()),
  requestId: av.optional(av.string()),
  status: av.optional(av.number()),
  headers: av.optional(av.record(av.string())),
  body: av.optional(av.string()),
  message: av.optional(av.string()),
  publicServerId: av.optional(av.string()),
  publicSocketId: av.optional(av.string()),
  frameType: av.optional(av.string()),
  path: av.optional(av.string()),
  webStartedAt: av.optional(av.number()),
  clientApiRoundtripMs: av.optional(av.number()),
  cliOverheadMs: av.optional(av.number()),
  originMs: av.optional(av.number()),
  totalMs: av.optional(av.number()),
  internalServerMs: av.optional(av.number())
}, { unknownKeys: "strip" });

export const TunnelConfigSchema = av.object({
  host: av.string().minLength(1).default("127.0.0.1"),
  port: av.number(),
  prefix: av.optional(av.string()),
  host_header: av.optional(av.string())
}, { unknownKeys: "strip" });
export type TunnelConfig = Infer<typeof TunnelConfigSchema>;

export const TunnelEntrySchema = av.object({
  host: av.string().minLength(1).default("127.0.0.1"),
  port: av.optional(av.number()),
  prefix: av.optional(av.string()),
  host_header: av.optional(av.string()),
  name: av.optional(av.string()),
  run: av.optional(av.string()),
  cwd: av.optional(av.string()),
  dir: av.optional(av.string()),
  health: av.optional(av.string()),
  ready_timeout: av.optional(av.number())
}, { unknownKeys: "strip" });
export type TunnelEntry = Infer<typeof TunnelEntrySchema>;

export const FileConfigSchema = av.object({
  tunnels: av.array(TunnelEntrySchema).default([])
}, { unknownKeys: "strip" });
export type FileConfig = Infer<typeof FileConfigSchema>;

export const AuthStartRequestSchema = av.object({
  deviceName: av.optional(av.string()),
  authAppBaseUrl: av.optional(av.string())
}, { unknownKeys: "strip" });
export type AuthStartRequest = Infer<typeof AuthStartRequestSchema>;

export const AuthStartResponseSchema = av.object({
  sessionId: av.string(),
  pollSecret: av.string(),
  browserUrl: av.string(),
  expiresAt: av.string()
}, { unknownKeys: "strip" });

export const AuthStatusResponseSchema = av.object({
  status: av.string(),
  token: av.optional(av.string()),
  expiresAt: av.optional(av.string()),
  tenantId: av.optional(av.string()),
  bpUserSubject: av.optional(av.string()),
  message: av.optional(av.string())
}, { unknownKeys: "strip" });
