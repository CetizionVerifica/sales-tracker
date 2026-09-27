import type { EnquiryStatus, QuotationStatus } from '@sales-tracker/db';
import { getDb } from '../clients.ts';
import { assertCan, type Ctx } from '../context.ts';
import { scopeEnquiries, scopeQuotations } from '../rbac/scope.ts';
import { todayInIST } from '../schemas/common.ts';
import { ACTIVE_QUOTATION_STATUSES } from '../status/quotation.ts';

/*
 * Counts for the list pages' summary strips (UI guide §4.1). Scoped exactly like the
 * lists, live records only, so each chip's number matches the filtered list it opens.
 */

export async function enquiryStatusCounts(ctx: Ctx): Promise<Record<EnquiryStatus, number>> {
  assertCan(ctx, 'list', 'enquiry');
  const rows = await getDb().enquiry.groupBy({
    by: ['status'],
    where: { AND: [scopeEnquiries(ctx.user)] },
    _count: { _all: true },
  });
  const counts: Record<EnquiryStatus, number> = { IN_PROGRESS: 0, CONVERTED: 0, LOST: 0 };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

export async function quotationStatusCounts(
  ctx: Ctx,
): Promise<Record<QuotationStatus, number> & { followUpDue: number }> {
  assertCan(ctx, 'list', 'quotation');
  const db = getDb();
  const scope = scopeQuotations(ctx.user);
  const [rows, followUpDue] = await Promise.all([
    db.quotation.groupBy({ by: ['status'], where: { AND: [scope] }, _count: { _all: true } }),
    db.quotation.count({
      where: {
        AND: [scope],
        status: { in: [...ACTIVE_QUOTATION_STATUSES] },
        nextFollowUpDate: { lte: todayInIST() },
      },
    }),
  ]);
  const counts = { SENT: 0, UNDER_NEGOTIATION: 0, PO_RECEIVED: 0, LOST: 0, followUpDue };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}
