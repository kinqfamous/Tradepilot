-- Referral onboarding is distinct from Phoenix access/allowlist onboarding.
ALTER TABLE "SystemState"
RENAME COLUMN "requirePhoenixAccessCode" TO "requirePhoenixReferralCode";

ALTER TABLE "ExchangeAccount"
RENAME COLUMN "phoenixAccessValidatedAt" TO "phoenixReferralActivatedAt";
