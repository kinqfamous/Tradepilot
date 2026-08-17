-- Add the setting used by group-trade commands. Existing users retain the
-- application default of $50 until they choose a different amount.
ALTER TABLE "UserSettings"
ADD COLUMN "defaultCollateralUsd" DECIMAL(20,8) NOT NULL DEFAULT 50;
