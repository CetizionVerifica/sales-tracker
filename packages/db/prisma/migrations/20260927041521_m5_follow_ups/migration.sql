-- CreateEnum
CREATE TYPE "FollowUpChannel" AS ENUM ('CALL', 'EMAIL', 'MEETING', 'SITE_VISIT', 'WHATSAPP', 'OTHER');

-- CreateEnum
CREATE TYPE "FollowUpEntityType" AS ENUM ('CLIENT', 'ENQUIRY', 'QUOTATION', 'PROJECT', 'PURCHASE_ORDER', 'INVOICE');

-- CreateTable
CREATE TABLE "follow_up" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" "FollowUpEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "contactId" TEXT,
    "date" DATE NOT NULL,
    "channel" "FollowUpChannel" NOT NULL,
    "notes" TEXT NOT NULL,
    "nextFollowUpDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "follow_up_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "follow_up_clientId_date_idx" ON "follow_up"("clientId", "date");

-- CreateIndex
CREATE INDEX "follow_up_entityType_entityId_date_idx" ON "follow_up"("entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "follow_up_userId_nextFollowUpDate_idx" ON "follow_up"("userId", "nextFollowUpDate");

-- AddForeignKey
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "client_contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The next follow-up cannot come before the touchpoint it follows.
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_next_after_date"
  CHECK ("nextFollowUpDate" IS NULL OR "nextFollowUpDate" >= "date");

-- A client-level follow-up is linked to its own client.
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_client_entity_is_client"
  CHECK ("entityType" <> 'CLIENT' OR "entityId" = "clientId");
