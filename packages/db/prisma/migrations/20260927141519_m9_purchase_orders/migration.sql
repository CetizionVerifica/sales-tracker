-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE');

-- CreateTable
CREATE TABLE "purchase_order" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "receivedDate" DATE NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "paymentTerms" TEXT,
    "paymentTermsDays" INTEGER,
    "description" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'PENDING',
    "statusChangedAt" TIMESTAMP(3),
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "purchase_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_service" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_service_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_documentId_key" ON "purchase_order"("documentId");

-- CreateIndex
CREATE INDEX "purchase_order_projectId_idx" ON "purchase_order"("projectId");

-- CreateIndex
CREATE INDEX "purchase_order_clientId_receivedDate_idx" ON "purchase_order"("clientId", "receivedDate");

-- CreateIndex
CREATE INDEX "purchase_order_status_idx" ON "purchase_order"("status");

-- CreateIndex
CREATE INDEX "purchase_order_clientId_poNumber_idx" ON "purchase_order"("clientId", "poNumber");

-- CreateIndex
CREATE INDEX "purchase_order_service_serviceId_idx" ON "purchase_order_service"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_service_purchaseOrderId_serviceId_key" ON "purchase_order_service"("purchaseOrderId", "serviceId");

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_service" ADD CONSTRAINT "purchase_order_service_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_service" ADD CONSTRAINT "purchase_order_service_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live PO per client and PO number, ignoring case (M9 Decision 2). Partial, so a
-- soft-deleted PO does not block re-entry. Prisma cannot express this; schema.prisma says so.
CREATE UNIQUE INDEX "purchase_order_live_client_number_key"
  ON "purchase_order"("clientId", lower("poNumber"))
  WHERE "deletedAt" IS NULL;

-- A PO authorises a positive amount (M9 Decision 6; CLAUDE.md rule 5).
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_amount_positive"
  CHECK ("amountMinor" > 0);

-- ISO 4217 codes are three upper-case letters.
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_currency_iso"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_po_number_length"
  CHECK (length(btrim("poNumber")) BETWEEN 1 AND 64);

-- Net days, when the terms state them (M9 Decision 7).
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_terms_days_range"
  CHECK ("paymentTermsDays" IS NULL OR "paymentTermsDays" BETWEEN 0 AND 365);
