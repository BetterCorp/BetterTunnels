import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";

export const AUTH_SESSION_TTL_MS = 10 * 60 * 1000;
export const DEVICE_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function shortBrowserKey(): string {
  return randomBytes(5).toString("base64url").toUpperCase();
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function verifySecret(value: string, hash: string): boolean {
  const left = Buffer.from(hashSecret(value));
  const right = Buffer.from(hash);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bearerToken(headers: Headers): string | undefined {
  const header = headers.get("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

export function normalizeIpRange(ip: string): { family: "ipv4" | "ipv6"; cidr: string } | undefined {
  const clean = ip.trim();
  const family = net.isIP(clean);
  if (family === 4) {
    const parts = clean.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    return { family: "ipv4", cidr: `${parts[0]}.${parts[1]}.${parts[2]}.0/24` };
  }
  if (family === 6) {
    const expanded = expandIpv6(clean);
    if (!expanded) return undefined;
    return { family: "ipv6", cidr: `${expanded.slice(0, 4).join(":")}:0000:0000:0000:0000/64` };
  }
  return undefined;
}

function expandIpv6(value: string): string[] | undefined {
  const [headRaw, tailRaw] = value.toLowerCase().split("::", 2);
  const head = headRaw ? headRaw.split(":") : [];
  const tail = tailRaw ? tailRaw.split(":") : [];
  if (value.includes("::")) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return undefined;
    return [...head, ...Array.from({ length: missing }, () => "0"), ...tail].map(padIpv6Part);
  }
  const parts = value.toLowerCase().split(":");
  return parts.length === 8 ? parts.map(padIpv6Part) : undefined;
}

function padIpv6Part(value: string): string {
  return value.padStart(4, "0");
}
