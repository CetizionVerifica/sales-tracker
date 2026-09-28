-- M11: My Today. The stale-enquiry threshold (M11 Decision 5).
ALTER TABLE "company_settings" ADD COLUMN "staleEnquiryDays" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_stale_enquiry_days_check"
  CHECK ("staleEnquiryDays" BETWEEN 1 AND 365);
