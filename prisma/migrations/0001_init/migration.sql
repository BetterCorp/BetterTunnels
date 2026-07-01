CREATE TYPE "TunnelStatus" AS ENUM ('created', 'active', 'draining', 'disconnected', 'expired', 'closed');

CREATE TABLE "Account" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ClientSession" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT,
  "ipHash" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ
);

CREATE TABLE "Tunnel" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT,
  "sessionId" TEXT NOT NULL,
  "subdomain" TEXT NOT NULL UNIQUE,
  "targetHost" TEXT NOT NULL,
  "targetPort" INTEGER NOT NULL,
  "authenticated" BOOLEAN NOT NULL DEFAULT false,
  "status" "TunnelStatus" NOT NULL DEFAULT 'created',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "Tunnel_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Tunnel_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClientSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "VisitorValidation" (
  "id" TEXT PRIMARY KEY,
  "tunnelId" TEXT NOT NULL,
  "visitorIpHash" TEXT NOT NULL,
  "userAgentHash" TEXT NOT NULL,
  "validationCookieHash" TEXT NOT NULL,
  "validatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "VisitorValidation_tunnelId_fkey" FOREIGN KEY ("tunnelId") REFERENCES "Tunnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "UsageCounter" (
  "tunnelId" TEXT PRIMARY KEY,
  "requests" INTEGER NOT NULL DEFAULT 0,
  "bytesIn" BIGINT NOT NULL DEFAULT 0,
  "bytesOut" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "UsageCounter_tunnelId_fkey" FOREIGN KEY ("tunnelId") REFERENCES "Tunnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "AuditEvent" (
  "id" TEXT PRIMARY KEY,
  "event" TEXT NOT NULL,
  "subjectId" TEXT,
  "data" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "Tunnel_sessionId_idx" ON "Tunnel"("sessionId");
CREATE INDEX "Tunnel_expiresAt_idx" ON "Tunnel"("expiresAt");
CREATE INDEX "VisitorValidation_tunnelId_visitorIpHash_userAgentHash_idx" ON "VisitorValidation"("tunnelId", "visitorIpHash", "userAgentHash");
