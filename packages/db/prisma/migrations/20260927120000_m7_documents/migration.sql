-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('QUOTATION', 'PURCHASE_ORDER', 'INVOICE');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DocumentReviewStatus" AS ENUM ('PENDING', 'CONFIRMED');

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "documentExtractionEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "quotation" ADD COLUMN     "documentId" TEXT;

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "entityId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'QUEUED',
    "extractionAttempts" INTEGER NOT NULL DEFAULT 0,
    "extractionError" TEXT,
    "extractionModel" TEXT,
    "extractedAt" TIMESTAMP(3),
    "extraction" JSONB,
    "reviewStatus" "DocumentReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "appliedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_storageKey_key" ON "document"("storageKey");

-- CreateIndex
CREATE INDEX "document_kind_entityId_idx" ON "document"("kind", "entityId");

-- CreateIndex
CREATE INDEX "document_clientId_createdAt_idx" ON "document"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "document_uploadedById_reviewStatus_idx" ON "document"("uploadedById", "reviewStatus");

-- CreateIndex
CREATE INDEX "document_extractionStatus_updatedAt_idx" ON "document"("extractionStatus", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_documentId_key" ON "quotation"("documentId");

-- AddForeignKey
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A confirmed review records who confirmed it and when (CLAUDE.md rule 9).
ALTER TABLE "document" ADD CONSTRAINT "document_confirmed_has_reviewer"
  CHECK ("reviewStatus" <> 'CONFIRMED' OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL));

ALTER TABLE "document" ADD CONSTRAINT "document_size_positive"
  CHECK ("sizeBytes" > 0);

-- A successful extraction always has its output.
ALTER TABLE "document" ADD CONSTRAINT "document_succeeded_has_extraction"
  CHECK ("extractionStatus" <> 'SUCCEEDED' OR "extraction" IS NOT NULL);
