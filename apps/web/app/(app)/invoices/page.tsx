import {
  can,
  getSettings,
  invoiceResource,
  invoiceStatusCounts,
  listClientOptions,
  listEnquiryOwnerOptions,
  listInvoices,
  listProjectManagerOptions,
  listServiceOptions,
} from '@sales-tracker/core';
import { listInvoicesSchema, toCalendarDateString, UNASSIGNED } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { DateRangeFilter } from '@/components/data/DateRangeFilter';
import { FilterBar, type FilterDef } from '@/components/data/FilterBar';
import { SummaryStrip } from '@/components/data/SummaryStrip';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { istToday } from '@/lib/display';
import { toOptions } from '@/lib/enquiry-labels';
import { DUE_WINDOW_LABELS, INVOICE_STATUS_LABELS } from '@/lib/invoice-labels';
import { filterKeys, isOnlyFilter, parseListParams, type SearchParams } from '@/lib/list-params';
import { DOCUMENT_STATE_LABELS } from '@/lib/purchase-order-labels';
import { InvoicesTable } from './InvoicesTable';

export const metadata = { title: 'Invoices · Sales Tracker' };

const asOptions = (rows: { id: string; name: string }[]) =>
  rows.map((row) => ({ value: row.id, label: row.name }));

/**
 * Admins see every invoice, Sales the invoices under their quotations, PMs those on
 * projects assigned to them (M10). Overdue is the only saffron here (UI guide §2).
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'invoice')) return <NoAccess />;
  const params = parseListParams(await searchParams, listInvoicesSchema);
  const isAdmin = can(ctx.user, 'list', 'user');
  const canCreate = can(ctx.user, 'create', 'invoice');
  // Admins and Sales filter by manager; PMs only see their own projects' invoices.
  const byManager = ctx.user.role !== 'PROJECT_MANAGER';
  const today = istToday();

  const [result, counts, clients, services, settings, managers, owners] = await Promise.all([
    listInvoices(ctx, isAdmin ? params : { ...params, ownerId: undefined }),
    invoiceStatusCounts(ctx),
    listClientOptions(ctx),
    listServiceOptions(ctx),
    getSettings(ctx),
    byManager ? listProjectManagerOptions(ctx) : null,
    isAdmin ? listEnquiryOwnerOptions(ctx) : null,
  ]);
  const raw = await searchParams;
  const filtered = filterKeys(raw).length > 0;
  const only = (key: string, value: string) => isOnlyFilter(raw, key, value);

  const filters: FilterDef[] = [
    {
      param: 'status',
      label: 'Statuses',
      options: toOptions(INVOICE_STATUS_LABELS),
      multi: true,
    },
    { param: 'due', label: 'Due', options: toOptions(DUE_WINDOW_LABELS) },
    { param: 'document', label: 'Documents', options: toOptions(DOCUMENT_STATE_LABELS) },
    { param: 'clientId', label: 'Clients', options: asOptions(clients) },
    { param: 'serviceId', label: 'Services', options: asOptions(services) },
    ...(managers
      ? [
          {
            param: 'managerId',
            label: 'Managers',
            options: [{ value: UNASSIGNED, label: 'Unassigned' }, ...asOptions(managers)],
          },
        ]
      : []),
    ...(owners ? [{ param: 'ownerId', label: 'Owners', options: asOptions(owners) }] : []),
    {
      param: 'currency',
      label: 'Currencies',
      multi: true,
      options: settings.enabledCurrencies.map((code) => ({ value: code, label: code })),
    },
    ...(canCreate
      ? [
          {
            param: 'recordStatus',
            label: 'Records',
            options: [{ value: 'deleted', label: 'Deleted' }],
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Record each invoice against its PO, and see what is due, overdue and paid"
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/invoices/new">New invoice</Link>
            </Button>
          )
        }
      />
      <SummaryStrip
        chips={[
          {
            label: 'Overdue',
            count: counts.OVERDUE,
            href: '/invoices?status=OVERDUE',
            active: only('status', 'OVERDUE'),
            attention: true,
          },
          {
            label: 'Due in 7 days',
            count: counts.dueNext7,
            href: '/invoices?due=next7',
            active: only('due', 'next7'),
          },
          {
            label: 'Pending',
            count: counts.PENDING,
            href: '/invoices?status=PENDING',
            active: only('status', 'PENDING'),
          },
          {
            label: 'To review',
            count: counts.toReview,
            href: '/invoices?document=toReview',
            active: only('document', 'toReview'),
          },
        ]}
      />
      <FilterBar
        searchPlaceholder="Search invoice or PO number, project, client, reference"
        filters={filters}
      >
        <DateRangeFilter label="Invoiced" fromParam="invoiceFrom" toParam="invoiceTo" />
        <DateRangeFilter label="Due" fromParam="dueFrom" toParam="dueTo" />
      </FilterBar>
      {params.sort === 'amount' && (
        <p className="text-muted-foreground text-[13px]">
          Amounts in different currencies are sorted by face value, not converted.
        </p>
      )}
      <InvoicesTable
        rows={result.items.map((invoice) => {
          const resource = invoiceResource(invoice);
          const live = invoice.deletedAt === null;
          return {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            client: invoice.client.name,
            purchaseOrderId: invoice.purchaseOrder.id,
            poNumber: invoice.purchaseOrder.poNumber,
            projectId: invoice.purchaseOrder.project.id,
            projectNumber: invoice.purchaseOrder.project.number,
            invoiceDate: invoice.invoiceDate.toISOString(),
            dueDate: invoice.dueDate.toISOString(),
            amountMinor: invoice.amountMinor.toString(),
            currency: invoice.currency,
            status: invoice.status,
            documentState: invoice.documentState,
            updatedAt: invoice.updatedAt.toISOString(),
            deleted: !live,
            canRestore: can(ctx.user, 'delete', resource),
            canMarkPaid: live && invoice.status !== 'PAID' && can(ctx.user, 'update', resource),
            invoiceDay: toCalendarDateString(invoice.invoiceDate),
            today,
          };
        })}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        sort={params.sort}
        dir={params.dir}
        filtered={filtered}
        canCreate={canCreate}
      />
    </>
  );
}
