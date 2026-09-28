import {
  can,
  getSettings,
  listClientOptions,
  listEnquiryOwnerOptions,
  listProjectManagerOptions,
  listProjects,
  listPurchaseOrders,
  listServiceOptions,
  purchaseOrderResource,
  purchaseOrderStatusCounts,
} from '@sales-tracker/core';
import { listPurchaseOrdersSchema, UNASSIGNED } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { DateRangeFilter } from '@/components/data/DateRangeFilter';
import { FilterBar, type FilterDef } from '@/components/data/FilterBar';
import { SummaryStrip } from '@/components/data/SummaryStrip';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { toOptions } from '@/lib/enquiry-labels';
import { filterKeys, isOnlyFilter, parseListParams, type SearchParams } from '@/lib/list-params';
import { DOCUMENT_STATE_LABELS, PURCHASE_ORDER_STATUS_LABELS } from '@/lib/purchase-order-labels';
import { PurchaseOrdersTable } from './PurchaseOrdersTable';

export const metadata = { title: 'Purchase orders · Sales Tracker' };

const asOptions = (rows: { id: string; name: string }[]) =>
  rows.map((row) => ({ value: row.id, label: row.name }));

/**
 * Admins see every PO, Sales the POs on their quotations' projects, PMs the POs on projects
 * assigned to them (M9). The status follows the PO's invoices, so there are no status
 * actions here (Decision 4).
 */
export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'purchaseOrder')) return <NoAccess />;
  const params = parseListParams(await searchParams, listPurchaseOrdersSchema);
  const isAdmin = can(ctx.user, 'list', 'user');
  const canCreate = can(ctx.user, 'create', 'purchaseOrder');
  // Admins and Sales filter by manager; PMs only see their own projects' POs.
  const byManager = ctx.user.role !== 'PROJECT_MANAGER';

  const [result, counts, clients, services, settings, projects, managers, owners] =
    await Promise.all([
      listPurchaseOrders(ctx, isAdmin ? params : { ...params, ownerId: undefined }),
      purchaseOrderStatusCounts(ctx),
      listClientOptions(ctx),
      listServiceOptions(ctx),
      getSettings(ctx),
      listProjects(ctx, { pageSize: 100, sort: 'number', dir: 'desc' }),
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
      options: toOptions(PURCHASE_ORDER_STATUS_LABELS),
      multi: true,
    },
    {
      param: 'document',
      label: 'Documents',
      options: toOptions(DOCUMENT_STATE_LABELS),
    },
    {
      param: 'projectId',
      label: 'Projects',
      options: projects.items.map((p) => ({ value: p.id, label: `${p.number} · ${p.name}` })),
    },
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
        title="Purchase orders"
        description="Record each client PO against its project, and see what has been billed"
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/purchase-orders/new">New PO</Link>
            </Button>
          )
        }
      />
      <SummaryStrip
        chips={[
          {
            label: 'Pending',
            count: counts.PENDING,
            href: '/purchase-orders?status=PENDING',
            active: only('status', 'PENDING'),
          },
          {
            label: 'Overdue',
            count: counts.OVERDUE,
            href: '/purchase-orders?status=OVERDUE',
            active: only('status', 'OVERDUE'),
            attention: true,
          },
          {
            label: 'Paid',
            count: counts.PAID,
            href: '/purchase-orders?status=PAID',
            active: only('status', 'PAID'),
          },
          {
            label: 'To review',
            count: counts.toReview,
            href: '/purchase-orders?document=toReview',
            active: only('document', 'toReview'),
          },
        ]}
      />
      <FilterBar searchPlaceholder="Search PO number, project, client, terms" filters={filters}>
        <DateRangeFilter label="Received" fromParam="receivedFrom" toParam="receivedTo" />
      </FilterBar>
      {params.sort === 'amount' && (
        <p className="text-muted-foreground text-[13px]">
          Amounts in different currencies are sorted by face value, not converted.
        </p>
      )}
      <PurchaseOrdersTable
        rows={result.items.map((po) => ({
          id: po.id,
          poNumber: po.poNumber,
          client: po.client.name,
          projectId: po.project.id,
          projectNumber: po.project.number,
          projectName: po.project.name,
          receivedDate: po.receivedDate.toISOString(),
          amountMinor: po.amountMinor.toString(),
          currency: po.currency,
          paymentTerms: po.paymentTerms,
          status: po.status,
          documentState: po.documentState,
          updatedAt: po.updatedAt.toISOString(),
          deleted: po.deletedAt !== null,
          canRestore: can(ctx.user, 'delete', purchaseOrderResource(po)),
        }))}
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
