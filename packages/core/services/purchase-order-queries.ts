import type { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import type { DocumentState } from '../schemas/document-state.ts';

/*
 * Queries shared by the PO, project and summary services (M9). Not exported from the
 * package: they take a Db, not a ctx, so callers check permissions first.
 */

/** Live POs on a project, totalled per currency and against the project's revenue. */
export interface PoTotals {
  /** Project currency first, then the others alphabetically. */
  byCurrency: { currency: string; amountMinor: bigint }[];
  /** The project's currency. */
  currency: string;
  /** Live POs in the project's currency. */
  coveredMinor: bigint;
  revenueMinor: bigint;
  /** POs in the project currency exceed its revenue: a warning, not an error (Decision 6). */
  overCovered: boolean;
}

export async function poTotals(
  db: Db,
  project: { id: string; currency: string; revenueMinor: bigint },
): Promise<PoTotals> {
  const rows = await db.purchaseOrder.groupBy({
    by: ['currency'],
    where: { projectId: project.id },
    _sum: { amountMinor: true },
  });
  const byCurrency = rows
    .map((row) => ({ currency: row.currency, amountMinor: row._sum.amountMinor ?? 0n }))
    .sort((a, b) =>
      a.currency === project.currency
        ? -1
        : b.currency === project.currency
          ? 1
          : a.currency.localeCompare(b.currency),
    );
  const coveredMinor =
    byCurrency.find((total) => total.currency === project.currency)?.amountMinor ?? 0n;
  return {
    byCurrency,
    currency: project.currency,
    coveredMinor,
    revenueMinor: project.revenueMinor,
    overCovered: coveredMinor > project.revenueMinor,
  };
}

/** The PO filter for each document state; the list and the summary chips share it. */
export const PO_DOCUMENT_WHERE: Record<DocumentState, Prisma.PurchaseOrderWhereInput> = {
  none: { documentId: null },
  reading: {
    document: { is: { reviewStatus: 'PENDING', extractionStatus: { in: ['QUEUED', 'RUNNING'] } } },
  },
  toReview: { document: { is: { reviewStatus: 'PENDING', extractionStatus: 'SUCCEEDED' } } },
  reviewed: { document: { is: { reviewStatus: 'CONFIRMED' } } },
  failed: {
    document: { is: { reviewStatus: 'PENDING', extractionStatus: { in: ['FAILED', 'SKIPPED'] } } },
  },
};
