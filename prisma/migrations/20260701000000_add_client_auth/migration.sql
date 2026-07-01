CREATE TYPE "AuthSessionStatus" AS ENUM ('pending', 'approved', 'consumed', 'expired', 'denied');

CREATE TABLE "ClientAuthSession" (
    "id" TEXT NOT NULL,
    "browserKeyHash" TEXT NOT NULL,
    "pollSecretHash" TEXT NOT NULL,
    "status" "AuthSessionStatus" NOT NULL DEFAULT 'pending',
    "tenantId" TEXT,
    "appId" TEXT,
    "bpUserSubject" TEXT,
    "bpUserEmail" TEXT,
    "clientIpHash" TEXT,
    "userAgentHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientAuthSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClientDeviceToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "tenantId" TEXT NOT NULL,
    "bpUserSubject" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT,
    "ipRangeHash" TEXT NOT NULL,
    "ipFamily" TEXT NOT NULL,
    "userAgentHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientDeviceToken_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientAuthSession_status_expiresAt_idx" ON "ClientAuthSession"("status", "expiresAt");

CREATE UNIQUE INDEX "ClientDeviceToken_tokenHash_key" ON "ClientDeviceToken"("tokenHash");

CREATE INDEX "ClientDeviceToken_tenantId_bpUserSubject_idx" ON "ClientDeviceToken"("tenantId", "bpUserSubject");

CREATE INDEX "ClientDeviceToken_expiresAt_idx" ON "ClientDeviceToken"("expiresAt");
