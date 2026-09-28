
-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "amountInrMinor" BIGINT,
ADD COLUMN     "fxRate" DECIMAL(14,6);

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "amountInrMinor" BIGINT,
ADD COLUMN     "fxRate" DECIMAL(14,6);

-- AlterTable
ALTER TABLE "purchase_order" ADD COLUMN     "amountInrMinor" BIGINT,
ADD COLUMN     "fxRate" DECIMAL(14,6);

-- AlterTable
ALTER TABLE "quotation" ADD COLUMN     "amountInrMinor" BIGINT,
ADD COLUMN     "fxRate" DECIMAL(14,6);

-- CreateTable
CREATE TABLE "exchange_rate" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "inrPerUnit" DECIMAL(14,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "exchange_rate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exchange_rate_currency_month_idx" ON "exchange_rate"("currency", "month");

-- CreateIndex
CREATE INDEX "enquiry_receivedDate_idx" ON "enquiry"("receivedDate");

-- CreateIndex
CREATE INDEX "invoice_invoiceDate_idx" ON "invoice"("invoiceDate");

-- CreateIndex
CREATE INDEX "invoice_paidAt_idx" ON "invoice"("paidAt");

-- CreateIndex
CREATE INDEX "project_managerId_completedDate_idx" ON "project"("managerId", "completedDate");

-- CreateIndex
CREATE INDEX "quotation_status_poReceivedDate_idx" ON "quotation"("status", "poReceivedDate");

-- CreateIndex
CREATE INDEX "quotation_status_statusChangedAt_idx" ON "quotation"("status", "statusChangedAt");


-- ─── M12: hand-written parts (Prisma cannot express these) ─────────────────────

-- One live rate per currency and month (M12 Decision 1). The @@index above serves lookups.
CREATE UNIQUE INDEX "exchange_rate_live_currency_month_key"
  ON "exchange_rate"("currency", "month") WHERE "deletedAt" IS NULL;

ALTER TABLE "exchange_rate"
  ADD CONSTRAINT "exchange_rate_rate_check" CHECK ("inrPerUnit" > 0),
  ADD CONSTRAINT "exchange_rate_month_check" CHECK (EXTRACT(DAY FROM "month") = 1),
  ADD CONSTRAINT "exchange_rate_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$' AND "currency" <> 'INR');

-- Backfill: INR records convert at 1 now. Other currencies stay null until an admin
-- enters rates (the exchange-rate service fills them; M12 Risks).
UPDATE "quotation" SET "fxRate" = 1, "amountInrMinor" = "amountMinor" WHERE "currency" = 'INR';
UPDATE "project" SET "fxRate" = 1, "amountInrMinor" = "revenueMinor" WHERE "currency" = 'INR';
UPDATE "purchase_order" SET "fxRate" = 1, "amountInrMinor" = "amountMinor" WHERE "currency" = 'INR';
UPDATE "invoice" SET "fxRate" = 1, "amountInrMinor" = "amountMinor" WHERE "currency" = 'INR';

-- The INR pair is set together; an INR record always has it, at exactly 1. Added after the
-- backfill. `IS NOT NULL` is spelled out: a NULL CHECK result would otherwise pass.
ALTER TABLE "quotation"
  ADD CONSTRAINT "quotation_fx_pair_check" CHECK (("amountInrMinor" IS NULL) = ("fxRate" IS NULL)),
  ADD CONSTRAINT "quotation_fx_inr_check" CHECK ("currency" <> 'INR' OR ("fxRate" IS NOT NULL AND "fxRate" = 1 AND "amountInrMinor" = "amountMinor"));
ALTER TABLE "project"
  ADD CONSTRAINT "project_fx_pair_check" CHECK (("amountInrMinor" IS NULL) = ("fxRate" IS NULL)),
  ADD CONSTRAINT "project_fx_inr_check" CHECK ("currency" <> 'INR' OR ("fxRate" IS NOT NULL AND "fxRate" = 1 AND "amountInrMinor" = "revenueMinor"));
ALTER TABLE "purchase_order"
  ADD CONSTRAINT "purchase_order_fx_pair_check" CHECK (("amountInrMinor" IS NULL) = ("fxRate" IS NULL)),
  ADD CONSTRAINT "purchase_order_fx_inr_check" CHECK ("currency" <> 'INR' OR ("fxRate" IS NOT NULL AND "fxRate" = 1 AND "amountInrMinor" = "amountMinor"));
ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_fx_pair_check" CHECK (("amountInrMinor" IS NULL) = ("fxRate" IS NULL)),
  ADD CONSTRAINT "invoice_fx_inr_check" CHECK ("currency" <> 'INR' OR ("fxRate" IS NOT NULL AND "fxRate" = 1 AND "amountInrMinor" = "amountMinor"));
