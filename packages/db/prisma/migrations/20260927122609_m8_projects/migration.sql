-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "managerId" TEXT,
    "name" TEXT NOT NULL,
    "revenueMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "statusChangedAt" TIMESTAMP(3),
    "completionPct" INTEGER NOT NULL DEFAULT 0,
    "startDate" DATE,
    "endDate" DATE,
    "completedDate" DATE,
    "holdReason" TEXT,
    "cancelReason" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_service" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_service_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_number_key" ON "project"("number");

-- CreateIndex
CREATE INDEX "project_quotationId_idx" ON "project"("quotationId");

-- CreateIndex
CREATE INDEX "project_managerId_status_idx" ON "project"("managerId", "status");

-- CreateIndex
CREATE INDEX "project_clientId_idx" ON "project"("clientId");

-- CreateIndex
CREATE INDEX "project_status_endDate_idx" ON "project"("status", "endDate");

-- CreateIndex
CREATE INDEX "project_service_serviceId_idx" ON "project_service"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "project_service_projectId_serviceId_key" ON "project_service"("projectId", "serviceId");

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_service" ADD CONSTRAINT "project_service_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_service" ADD CONSTRAINT "project_service_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live project per quotation (M8 Decision 2). Partial, so a soft-deleted project does
-- not block its replacement. Prisma cannot express this; schema.prisma says so.
CREATE UNIQUE INDEX "project_live_quotation_key" ON "project"("quotationId")
  WHERE "deletedAt" IS NULL;

-- Money is never negative (CLAUDE.md rule 5).
ALTER TABLE "project" ADD CONSTRAINT "project_revenue_non_negative"
  CHECK ("revenueMinor" >= 0);

-- ISO 4217 codes are three upper-case letters.
ALTER TABLE "project" ADD CONSTRAINT "project_currency_iso"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "project" ADD CONSTRAINT "project_completion_range"
  CHECK ("completionPct" BETWEEN 0 AND 100);

-- A completed project is 100% done and records when it finished (M8 Decision 7).
ALTER TABLE "project" ADD CONSTRAINT "project_completed_needs_date"
  CHECK ("status" <> 'COMPLETED' OR ("completionPct" = 100 AND "completedDate" IS NOT NULL));

-- Once a project leaves NOT_STARTED it has a start date.
ALTER TABLE "project" ADD CONSTRAINT "project_started_needs_start_date"
  CHECK ("status" = 'NOT_STARTED' OR "startDate" IS NOT NULL);

-- A project on hold says why (M8 Decision 11).
ALTER TABLE "project" ADD CONSTRAINT "project_on_hold_needs_reason"
  CHECK ("status" <> 'ON_HOLD' OR "holdReason" IS NOT NULL);

-- A cancelled project says why (M8 Decision 12).
ALTER TABLE "project" ADD CONSTRAINT "project_cancelled_needs_reason"
  CHECK ("status" <> 'CANCELLED' OR "cancelReason" IS NOT NULL);

ALTER TABLE "project" ADD CONSTRAINT "project_end_after_start"
  CHECK ("endDate" IS NULL OR "startDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "project" ADD CONSTRAINT "project_completed_after_start"
  CHECK ("completedDate" IS NULL OR "startDate" IS NULL OR "completedDate" >= "startDate");
