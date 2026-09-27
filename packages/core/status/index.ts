// Status-machine functions (enquiry, quotation, invoice, derived PO status).
// Enquiry added in M4, quotation in M6; PO and invoice follow in M9 and M10.
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
  assertCanConfirm,
  assertCanRetry,
  assertExtractionTransition,
  canTransitionExtraction,
  EXTRACTION_STATUS_LABELS,
  FINISHED_EXTRACTION,
} from './document.ts';
