-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('SENT', 'UNDER_NEGOTIATION', 'PO_RECEIVED', 'LOST');

-- CreateTable
CREATE TABLE "quotation" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sectorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "quotationDate" DATE NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'SENT',
    "nextFollowUpDate" DATE,
    "lastFollowUpHighlights" TEXT,
    "lastFollowUpId" TEXT,
    "poReceivedDate" DATE,
    "lostReason" TEXT,
    "description" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_service" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotation_service_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotation_number_key" ON "quotation"("number");

-- CreateIndex
CREATE INDEX "quotation_ownerId_status_nextFollowUpDate_idx" ON "quotation"("ownerId", "status", "nextFollowUpDate");

-- CreateIndex
CREATE INDEX "quotation_enquiryId_idx" ON "quotation"("enquiryId");

-- CreateIndex
CREATE INDEX "quotation_clientId_idx" ON "quotation"("clientId");

-- CreateIndex
CREATE INDEX "quotation_status_quotationDate_idx" ON "quotation"("status", "quotationDate");

-- CreateIndex
CREATE INDEX "quotation_service_serviceId_idx" ON "quotation_service"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_service_quotationId_serviceId_key" ON "quotation_service"("quotationId", "serviceId");

-- AddForeignKey
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "enquiry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_service" ADD CONSTRAINT "quotation_service_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_service" ADD CONSTRAINT "quotation_service_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money is never negative (CLAUDE.md rule 5).
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_amount_non_negative"
  CHECK ("amountMinor" >= 0);

-- ISO 4217 codes are three upper-case letters.
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_currency_iso"
  CHECK ("currency" ~ '^[A-Z]{3}$');

-- An open quotation always has a next follow-up date (CLAUDE.md status machines).
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_active_needs_next_follow_up"
  CHECK ("status" NOT IN ('SENT', 'UNDER_NEGOTIATION') OR "nextFollowUpDate" IS NOT NULL);

-- A won quotation records when the PO arrived (M6 Decision 8).
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_po_received_needs_date"
  CHECK ("status" <> 'PO_RECEIVED' OR "poReceivedDate" IS NOT NULL);

ALTER TABLE "quotation" ADD CONSTRAINT "quotation_po_after_quotation"
  CHECK ("poReceivedDate" IS NULL OR "poReceivedDate" >= "quotationDate");

-- A lost quotation says why (M6 Decision 11).
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_lost_needs_reason"
  CHECK ("status" <> 'LOST' OR "lostReason" IS NOT NULL);
