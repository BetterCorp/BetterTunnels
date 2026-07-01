CREATE TYPE "AccountPlan" AS ENUM ('anonymous', 'free', 'paid', 'admin');

ALTER TABLE "Account"
  ADD COLUMN "plan" "AccountPlan" NOT NULL DEFAULT 'anonymous',
  ADD COLUMN "verificationBypass" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ipVerification" BOOLEAN NOT NULL DEFAULT false;
