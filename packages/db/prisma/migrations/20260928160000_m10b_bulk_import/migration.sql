-- CreateEnum
CREATE TYPE "ImportEntity" AS ENUM ('ENQUIRY');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('UPLOADED', 'PARSING', 'MAPPING', 'VALIDATING', 'READY', 'COMMITTING', 'COMMITTED', 'FAILED', 'UNDONE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('READY', 'WARNING', 'ERROR', 'DUPLICATE', 'EXCLUDED');

-- AlterTable
ALTER TABLE "client" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "importDateFormat" TEXT NOT NULL DEFAULT 'DD/MM/YYYY';

-- AlterTable
ALTER TABLE "enquiry" ADD COLUMN     "importBatchId" TEXT;

-- CreateTable
CREATE TABLE "import_batch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileStorageKey" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "entity" "ImportEntity" NOT NULL,
    "options" JSONB NOT NULL,
    "parsed" JSONB,
    "sheetConfig" JSONB,
    "mapping" JSONB,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "counts" JSONB,
    "createdById" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sheetName" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "original" JSONB NOT NULL,
    "transformed" JSONB,
    "resolved" JSONB,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'READY',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "resultRecordIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_row_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batch_createdById_status_idx" ON "import_batch"("createdById", "status");

-- CreateIndex
CREATE INDEX "import_batch_expiresAt_idx" ON "import_batch"("expiresAt");

-- CreateIndex
CREATE INDEX "import_row_batchId_status_idx" ON "import_row"("batchId", "status");

-- CreateIndex
CREATE INDEX "client_importBatchId_idx" ON "client"("importBatchId");

-- CreateIndex
CREATE INDEX "enquiry_importBatchId_idx" ON "enquiry"("importBatchId");

-- AddForeignKey
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "import_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
