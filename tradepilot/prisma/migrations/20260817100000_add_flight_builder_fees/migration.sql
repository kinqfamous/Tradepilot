-- Phoenix Flight builder configuration and per-order fee audit trail.
-- This migration is additive and safe to deploy before enabling Flight fees.
CREATE TYPE "BuilderRegistrationStatus" AS ENUM ('UNREGISTERED', 'PENDING', 'REGISTERED', 'FAILED');
CREATE TYPE "FeeEventStatus" AS ENUM ('EXPECTED', 'PENDING', 'CONFIRMED', 'FAILED', 'RECONCILIATION_REQUIRED');

CREATE TABLE "BuilderConfig" (
    "id" SERIAL NOT NULL,
    "builderAuthority" TEXT,
    "builderTraderAccount" TEXT,
    "builderPdaIndex" INTEGER NOT NULL DEFAULT 0,
    "builderSubaccountIndex" INTEGER NOT NULL DEFAULT 0,
    "registrationStatus" "BuilderRegistrationStatus" NOT NULL DEFAULT 'UNREGISTERED',
    "registrationCheckedAt" TIMESTAMP(3),
    "builderFeeBps" INTEGER NOT NULL DEFAULT 8,
    "maxFeeBps" INTEGER NOT NULL DEFAULT 50,
    "builderFeeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BuilderConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeeEvent" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "orderId" INTEGER,
    "tradeId" INTEGER,
    "market" TEXT NOT NULL,
    "builderAuthority" TEXT,
    "builderPdaIndex" INTEGER NOT NULL,
    "builderSubaccountIndex" INTEGER NOT NULL,
    "notionalUsd" DECIMAL(20,8) NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "expectedFeeUsd" DECIMAL(20,8) NOT NULL,
    "confirmedFeeUsd" DECIMAL(20,8),
    "status" "FeeEventStatus" NOT NULL DEFAULT 'EXPECTED',
    "builderTxSignature" TEXT,
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "FeeEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeeEvent_idempotencyKey_key" ON "FeeEvent"("idempotencyKey");
CREATE INDEX "FeeEvent_userId_idx" ON "FeeEvent"("userId");
CREATE INDEX "FeeEvent_status_idx" ON "FeeEvent"("status");
CREATE INDEX "FeeEvent_market_idx" ON "FeeEvent"("market");

ALTER TABLE "FeeEvent" ADD CONSTRAINT "FeeEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeeEvent" ADD CONSTRAINT "FeeEvent_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeeEvent" ADD CONSTRAINT "FeeEvent_tradeId_fkey"
  FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
