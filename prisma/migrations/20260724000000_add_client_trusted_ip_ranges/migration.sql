CREATE TABLE "ClientTrustedIpRange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bpUserSubject" TEXT NOT NULL,
    "ipRangeHash" TEXT NOT NULL,
    "ipFamily" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientTrustedIpRange_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientTrustedIpRange_tenantId_bpUserSubject_ipFamily_ipRangeHash_key"
ON "ClientTrustedIpRange"("tenantId", "bpUserSubject", "ipFamily", "ipRangeHash");

CREATE INDEX "ClientTrustedIpRange_expiresAt_idx"
ON "ClientTrustedIpRange"("expiresAt");
