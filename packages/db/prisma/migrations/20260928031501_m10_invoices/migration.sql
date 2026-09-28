-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE');

-- CreateEnum
CREATE TYPE "DueDateBasis" AS ENUM ('PO_TERMS', 'COMPANY_DEFAULT', 'MANUAL');

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "serviceId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "dueDateBasis" "DueDateBasis" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "statusChangedAt" TIMESTAMP(3),
    "paidAt" DATE,
    "paymentReference" TEXT,
    "unmarkedPaidReason" TEXT,
    "description" TEXT,
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_documentId_key" ON "invoice"("documentId");

-- CreateIndex
CREATE INDEX "invoice_purchaseOrderId_idx" ON "invoice"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "invoice_clientId_invoiceDate_idx" ON "invoice"("clientId", "invoiceDate");

-- CreateIndex
CREATE INDEX "invoice_status_dueDate_idx" ON "invoice"("status", "dueDate");

-- CreateIndex
CREATE INDEX "invoice_serviceId_idx" ON "invoice"("serviceId");

-- CreateIndex
CREATE INDEX "invoice_invoiceNumber_idx" ON "invoice"("invoiceNumber");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One live invoice per number company-wide, ignoring case (M10 Decision 2). Partial, so a
-- soft-deleted invoice does not block re-entry. Prisma cannot express this; schema.prisma says so.
CREATE UNIQUE INDEX "invoice_live_number_key"
  ON "invoice"(lower("invoiceNumber"))
  WHERE "deletedAt" IS NULL;

-- An invoice bills a positive amount (CLAUDE.md rule 5).
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_amount_positive"
  CHECK ("amountMinor" > 0);

-- ISO 4217 codes are three upper-case letters.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_currency_iso"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_number_length"
  CHECK (length(btrim("invoiceNumber")) BETWEEN 1 AND 64);

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_due_after_invoice_date"
  CHECK ("dueDate" >= "invoiceDate");

-- PAID exactly when the payment date is known, and never before the invoice was raised.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_paid_has_date"
  CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL));

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_paid_after_invoice_date"
  CHECK ("paidAt" IS NULL OR "paidAt" >= "invoiceDate");
