-- Users choose a default margin mode. Phoenix may still force ISOLATED for
-- isolated-only markets such as WTIOIL.
CREATE TYPE "MarginMode" AS ENUM ('CROSS', 'ISOLATED');

ALTER TABLE "UserSettings"
ADD COLUMN "defaultMarginMode" "MarginMode" NOT NULL DEFAULT 'CROSS';
