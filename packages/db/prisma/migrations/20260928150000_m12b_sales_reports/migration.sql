-- AlterTable
ALTER TABLE "sector" ADD COLUMN     "isOther" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "purchase_order_line" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountInrMinor" BIGINT,
    "fxRate" DECIMAL(14,6),
    "allocationEstimated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_order_line_purchaseOrderId_idx" ON "purchase_order_line"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "purchase_order_line_serviceId_idx" ON "purchase_order_line"("serviceId");

-- CreateIndex
CREATE INDEX "enquiry_clientId_receivedDate_idx" ON "enquiry"("clientId", "receivedDate");

-- CreateIndex
CREATE INDEX "purchase_order_receivedDate_idx" ON "purchase_order"("receivedDate");

-- AddForeignKey
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── M12b: hand-written parts (Prisma cannot express these) ─────────────────────

-- A line's amount must be above zero and its currency the PO's own ISO code, as on the PO
-- itself (m9_purchase_orders, m6_quotations).
ALTER TABLE "purchase_order_line"
  ADD CONSTRAINT "purchase_order_line_amount_check" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "purchase_order_line_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- The INR pair is set together, as the M12 money models (purchase_order_fx_pair_check).
ALTER TABLE "purchase_order_line"
  ADD CONSTRAINT "purchase_order_line_fx_pair_check" CHECK (("amountInrMinor" IS NULL) = ("fxRate" IS NULL));

-- Backfill: one line per service on every existing purchase order. A single service takes
-- the full amount; several split it evenly, the remainder (in minor units, and separately in
-- INR minor units) going to the first lines by service-link creation order, marked
-- allocationEstimated since nobody confirmed the split. INR values backfill only where the
-- PO already has one (M12 Decision 1); a PO with no rate yet gets NULL lines, like the PO.
WITH ordered AS (
  SELECT
    pos."purchaseOrderId" AS po_id,
    pos."serviceId" AS service_id,
    po."amountMinor" AS po_amount,
    po."currency" AS po_currency,
    po."amountInrMinor" AS po_amount_inr,
    po."fxRate" AS po_fx_rate,
    COUNT(*) OVER (PARTITION BY pos."purchaseOrderId") AS service_count,
    ROW_NUMBER() OVER (PARTITION BY pos."purchaseOrderId" ORDER BY pos."createdAt", pos.id) AS rn
  FROM "purchase_order_service" pos
  JOIN "purchase_order" po ON po.id = pos."purchaseOrderId"
),
split AS (
  SELECT
    *,
    (po_amount / service_count) AS base_share,
    (po_amount - (po_amount / service_count) * service_count) AS remainder,
    CASE WHEN po_amount_inr IS NULL THEN NULL ELSE (po_amount_inr / service_count) END AS base_share_inr,
    CASE WHEN po_amount_inr IS NULL THEN NULL
         ELSE (po_amount_inr - (po_amount_inr / service_count) * service_count) END AS remainder_inr
  FROM ordered
)
INSERT INTO "purchase_order_line"
  ("id", "purchaseOrderId", "serviceId", "amountMinor", "currency", "amountInrMinor", "fxRate",
   "allocationEstimated", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  po_id,
  service_id,
  base_share + CASE WHEN rn <= remainder THEN 1 ELSE 0 END,
  po_currency,
  CASE WHEN po_amount_inr IS NULL THEN NULL
       ELSE base_share_inr + CASE WHEN rn <= remainder_inr THEN 1 ELSE 0 END END,
  po_fx_rate,
  service_count > 1,
  now(),
  now()
FROM split;
