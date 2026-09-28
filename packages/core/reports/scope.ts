import type { Prisma } from '@sales-tracker/db';
import { assertCan, type Ctx } from '../context.ts';
import { ForbiddenError } from '../errors.ts';
import {
  scopeEnquiries,
  scopeInvoices,
  scopePurchaseOrders,
  scopeQuotations,
} from '../rbac/scope.ts';
import type { Actor } from '../rbac/types.ts';

/*
 * Whose numbers a sales report shows (M12b: "ADMIN sees company-wide reports and can filter
 * by owner. SALES sees reports scoped to their own records ... PROJECT_MANAGER has no
 * access"). Unlike the M12 dashboard there is no project/manager scope: a PM never resolves
 * one, since `report` policy denies every PROJECT_MANAGER read regardless of kind.
 */

export type ReportScopeKind = 'company' | 'personal';

export interface ReportScope {
  kind: ReportScopeKind;
  viewer: Actor;
  /** The Sales user the report is scoped to (forced to the viewer, for Sales); null for the
   * company. */
  ownerId: string | null;
}

/** Sales are always forced to their own pipeline; only an admin may pick another owner. */
export function resolveReportScope(ctx: Ctx, input: { ownerId?: string | undefined }): ReportScope {
  const viewer = ctx.user;
  if (viewer.role !== 'ADMIN' && input.ownerId) {
    throw new ForbiddenError('read', 'report');
  }
  const kind: ReportScopeKind = viewer.role === 'SALES' || input.ownerId ? 'personal' : 'company';
  assertCan(ctx, 'read', { type: 'report', scope: kind });
  const ownerId = viewer.role === 'SALES' ? viewer.id : (input.ownerId ?? null);
  return { kind, viewer, ownerId };
}

const liveClient = { client: { deletedAt: null } };

/** Live enquiries in scope, with a live client. */
export function enquiriesIn(s: ReportScope): Prisma.EnquiryWhereInput {
  return {
    AND: [
      scopeEnquiries(s.viewer),
      { deletedAt: null, ...liveClient },
      s.ownerId ? { ownerId: s.ownerId } : {},
    ],
  };
}

/** Live quotations in scope, with a live client. */
export function quotationsIn(s: ReportScope): Prisma.QuotationWhereInput {
  return {
    AND: [
      scopeQuotations(s.viewer),
      { deletedAt: null, ...liveClient },
      s.ownerId ? { ownerId: s.ownerId } : {},
    ],
  };
}

/** Live POs in scope, with a live client, by the pipeline owner (through the project). */
export function purchaseOrdersIn(s: ReportScope): Prisma.PurchaseOrderWhereInput {
  return {
    AND: [
      scopePurchaseOrders(s.viewer),
      { deletedAt: null, ...liveClient },
      s.ownerId ? { project: { quotation: { ownerId: s.ownerId } } } : {},
    ],
  };
}

/** Live invoices on live POs and projects in scope, with a live client. */
export function invoicesIn(s: ReportScope): Prisma.InvoiceWhereInput {
  return {
    AND: [
      scopeInvoices(s.viewer),
      {
        deletedAt: null,
        ...liveClient,
        purchaseOrder: { deletedAt: null, project: { deletedAt: null } },
      },
      s.ownerId ? { purchaseOrder: { project: { quotation: { ownerId: s.ownerId } } } } : {},
    ],
  };
}
