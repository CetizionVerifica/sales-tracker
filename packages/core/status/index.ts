// Status-machine functions (enquiry, quotation, invoice, derived PO status).
// Enquiry added in M4, quotation in M6, project in M8; PO and invoice follow in M9 and M10.
export { assertEnquiryTransition, canTransitionEnquiry } from './enquiry.ts';
export {
  ACTIVE_QUOTATION_STATUSES,
  assertQuotationTransition,
  canTransitionQuotation,
  CLOSED_QUOTATION_EDITABLE,
  isActiveQuotation,
  QUOTATION_STATUS_LABELS,
} from './quotation.ts';
export {
  ACTIVE_PROJECT_STATUSES,
  assertProjectTransition,
  canTransitionProject,
  CLOSED_PROJECT_EDITABLE,
  isActiveProject,
  isBehindSchedule,
  PROJECT_STATUS_LABELS,
} from './project.ts';
export {
  assertCanConfirm,
  assertCanRetry,
  assertExtractionTransition,
  canTransitionExtraction,
  EXTRACTION_STATUS_LABELS,
  FINISHED_EXTRACTION,
} from './document.ts';
