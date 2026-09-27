-- A project can be cancelled before it starts (M8 Decision 12), so CANCELLED joins
-- NOT_STARTED as a status that may have no start date.
ALTER TABLE "project" DROP CONSTRAINT "project_started_needs_start_date";
ALTER TABLE "project" ADD CONSTRAINT "project_started_needs_start_date"
  CHECK ("status" IN ('NOT_STARTED', 'CANCELLED') OR "startDate" IS NOT NULL);
