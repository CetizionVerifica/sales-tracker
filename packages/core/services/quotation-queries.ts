import type { Prisma } from '@sales-tracker/db';
import { istStartOf } from '../schemas/report.ts';

/*
 * "Decided" quotations (M12): shared by the dashboard's win rate and the quotation list's
 * `decidedFrom`/`decidedTo` filter, so a conversion bar and the list it opens agree. Not
 * exported from the package: plain where-clauses, no permission checks.
 */

const DAY_MS = 86_400_000;
type Span = { from: Date; to: Date };

/** Quotations won in a span: PO received, by `poReceivedDate`. */
export const wonIn = (span: Span): Prisma.QuotationWhereInput => ({
  status: 'PO_RECEIVED',
  poReceivedDate: { gte: span.from, lte: span.to },
});

/** Quotations lost in a span: `LOST`, by the IST day of `statusChangedAt`. */
export const lostIn = (span: Span): Prisma.QuotationWhereInput => ({
  status: 'LOST',
  statusChangedAt: {
    gte: istStartOf(span.from),
    lt: istStartOf(new Date(span.to.getTime() + DAY_MS)),
  },
});
