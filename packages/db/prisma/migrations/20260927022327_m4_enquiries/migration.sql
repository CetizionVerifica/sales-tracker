-- CreateEnum
CREATE TYPE "EnquiryStatus" AS ENUM ('IN_PROGRESS', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "EnquirySource" AS ENUM ('EMAIL', 'PHONE', 'TENDER_PORTAL', 'REFERRAL', 'WEBSITE', 'WALK_IN', 'OTHER');

-- CreateTable
CREATE TABLE "enquiry" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sectorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "receivedDate" DATE NOT NULL,
    "proposalSentDate" DATE,
    "source" "EnquirySource" NOT NULL,
    "sourceDetail" TEXT,
    "description" TEXT,
    "status" "EnquiryStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "lostReason" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "enquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiry_service" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enquiry_service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequence" (
    "id" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "number_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enquiry_number_key" ON "enquiry"("number");

-- CreateIndex
CREATE INDEX "enquiry_ownerId_status_idx" ON "enquiry"("ownerId", "status");

-- CreateIndex
CREATE INDEX "enquiry_clientId_idx" ON "enquiry"("clientId");

-- CreateIndex
CREATE INDEX "enquiry_status_receivedDate_idx" ON "enquiry"("status", "receivedDate");

-- CreateIndex
CREATE INDEX "enquiry_source_idx" ON "enquiry"("source");

-- CreateIndex
CREATE INDEX "enquiry_service_serviceId_idx" ON "enquiry_service"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "enquiry_service_enquiryId_serviceId_key" ON "enquiry_service"("enquiryId", "serviceId");

-- AddForeignKey
ALTER TABLE "enquiry" ADD CONSTRAINT "enquiry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry" ADD CONSTRAINT "enquiry_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry" ADD CONSTRAINT "enquiry_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_service" ADD CONSTRAINT "enquiry_service_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "enquiry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_service" ADD CONSTRAINT "enquiry_service_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A proposal cannot be sent before the enquiry was received.
ALTER TABLE "enquiry" ADD CONSTRAINT "enquiry_proposal_after_received"
  CHECK ("proposalSentDate" IS NULL OR "proposalSentDate" >= "receivedDate");

-- Final guard for the status machine: CONVERTED requires a proposal sent date.
ALTER TABLE "enquiry" ADD CONSTRAINT "enquiry_converted_has_proposal"
  CHECK ("status" <> 'CONVERTED' OR "proposalSentDate" IS NOT NULL);
