import { getDb } from '../clients.ts';
import { assertCan, type Ctx } from '../context.ts';
import { can } from '../rbac/can.ts';
import {
  scopeEnquiries,
  scopeInvoices,
  scopeProjects,
  scopePurchaseOrders,
  scopeQuotations,
} from '../rbac/scope.ts';
import {
  searchRecordsSchema,
  type SearchRecordsInput,
  type SearchResultType,
} from '../schemas/search.ts';
import { invoiceLabel, purchaseOrderLabel } from './follow-up-targets.ts';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  /** The record's identifier or the client's name. */
  label: string;
  /** Secondary text: the client for enquiries and quotations, the name for projects, the
   * client and project number for POs, the client and PO for invoices, the sector for clients. */
  detail: string;
}

/**
 * The ⌘K palette's search (UI guide §3): enquiries and quotations by number or client name,
 * projects by number, name or client name (M8), POs by the client's PO number (M9), invoices
 * by number (M10), clients by name. Each type is scoped exactly like its list, so a rep never sees another rep's
 * records; types the user cannot list are skipped. Live records only.
 */
export async function searchRecords(ctx: Ctx, input: SearchRecordsInput): Promise<SearchResult[]> {
  const { q, limit } = searchRecordsSchema.parse(input);
  assertCan(ctx, 'read', 'client'); // everyone active can; an inactive user is refused
  const db = getDb();
  const contains = { contains: q, mode: 'insensitive' as const };
  const byNumberOrClient = { OR: [{ number: contains }, { client: { name: contains } }] };

  const [enquiries, quotations, projects, purchaseOrders, invoices, clients] = await Promise.all([
    can(ctx.user, 'list', 'enquiry')
      ? db.enquiry.findMany({
          where: { AND: [scopeEnquiries(ctx.user), byNumberOrClient] },
          select: { id: true, number: true, client: { select: { name: true } } },
          orderBy: { number: 'desc' },
          take: limit,
        })
      : [],
    can(ctx.user, 'list', 'quotation')
      ? db.quotation.findMany({
          where: { AND: [scopeQuotations(ctx.user), byNumberOrClient] },
          select: { id: true, number: true, client: { select: { name: true } } },
          orderBy: { number: 'desc' },
          take: limit,
        })
      : [],
    can(ctx.user, 'list', 'project')
      ? db.project.findMany({
          where: {
            AND: [scopeProjects(ctx.user), { OR: [...byNumberOrClient.OR, { name: contains }] }],
          },
          select: { id: true, number: true, name: true },
          orderBy: { number: 'desc' },
          take: limit,
        })
      : [],
    can(ctx.user, 'list', 'purchaseOrder')
      ? db.purchaseOrder.findMany({
          where: { AND: [scopePurchaseOrders(ctx.user), { poNumber: contains }] },
          select: {
            id: true,
            poNumber: true,
            client: { select: { name: true } },
            project: { select: { number: true } },
          },
          orderBy: [{ receivedDate: 'desc' }, { id: 'asc' }],
          take: limit,
        })
      : [],
    can(ctx.user, 'list', 'invoice')
      ? db.invoice.findMany({
          where: { AND: [scopeInvoices(ctx.user), { invoiceNumber: contains }] },
          select: {
            id: true,
            invoiceNumber: true,
            client: { select: { name: true } },
            purchaseOrder: { select: { poNumber: true } },
          },
          orderBy: [{ invoiceDate: 'desc' }, { id: 'asc' }],
          take: limit,
        })
      : [],
    db.client.findMany({
      where: { name: contains },
      select: { id: true, name: true, sector: { select: { name: true } } },
      orderBy: { name: 'asc' },
      take: limit,
    }),
  ]);

  return [
    ...enquiries.map((e) => ({
      type: 'ENQUIRY' as const,
      id: e.id,
      label: e.number,
      detail: e.client.name,
    })),
    ...quotations.map((x) => ({
      type: 'QUOTATION' as const,
      id: x.id,
      label: x.number,
      detail: x.client.name,
    })),
    ...projects.map((p) => ({
      type: 'PROJECT' as const,
      id: p.id,
      label: p.number,
      detail: p.name,
    })),
    ...purchaseOrders.map((po) => ({
      type: 'PURCHASE_ORDER' as const,
      id: po.id,
      label: purchaseOrderLabel(po),
      detail: `${po.client.name} · ${po.project.number}`,
    })),
    ...invoices.map((invoice) => ({
      type: 'INVOICE' as const,
      id: invoice.id,
      label: invoiceLabel(invoice),
      detail: `${invoice.client.name} · ${purchaseOrderLabel(invoice.purchaseOrder)}`,
    })),
    ...clients.map((c) => ({
      type: 'CLIENT' as const,
      id: c.id,
      label: c.name,
      detail: c.sector.name,
    })),
  ];
}
