ALTER TABLE "Tunnel" ADD COLUMN "publicUrl" TEXT;

UPDATE "Tunnel"
SET "publicUrl" = 'https://' || "subdomain" || '.tunnels.betterportal.dev';
