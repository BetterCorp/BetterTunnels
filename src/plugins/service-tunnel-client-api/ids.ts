import { createHash, randomBytes } from "node:crypto";

export function randomPrefix(): string {
  return randomBytes(4).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6).padEnd(6, "0");
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeHostPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "host";
}

export function buildSubdomain(prefix: string, port: number, host: string): string {
  return `${prefix}-port${port}-${normalizeHostPart(host)}`;
}

export function buildTunnelSubdomain(prefix: string, port: number, creatorIp: string): string {
  return buildSubdomain(prefix, port, creatorIp);
}
