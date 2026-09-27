// Status-machine functions (enquiry, quotation, invoice, derived PO status).
// Enquiry added in M4; quotation, PO and invoice follow in M6, M9 and M10.
export { assertEnquiryTransition, canTransitionEnquiry } from './enquiry.ts';
