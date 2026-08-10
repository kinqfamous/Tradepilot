-- Require a Phoenix invite/referral code for onboarding by default, while
-- allowing the TradePilot owner to switch the gate off through SystemState.
ALTER TABLE "SystemState"
ADD COLUMN "requirePhoenixAccessCode" BOOLEAN NOT NULL DEFAULT true;

-- Store only proof that the wallet passed Phoenix's invite flow. Access codes
-- are bearer credentials and must not be stored in TradePilot's database.
ALTER TABLE "ExchangeAccount"
ADD COLUMN "phoenixAccessValidatedAt" TIMESTAMP(3);
