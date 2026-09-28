import {
  can,
  getClient,
  getClientTimeline,
  getCurrentDocument,
  getEnv,
  invoiceResource,
  listDocuments,
  listInvoicesForPurchaseOrder,
} from '@sales-tracker/core';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { RecordAudit } from '@/components/audit/RecordAudit';
import { Panel } from '@/components/charts/Panel';
import { DateDisplay } from '@/components/display/DateDisplay';
import { FieldGrid } from '@/components/display/FieldGrid';
import { Money } from '@/components/display/Money';
import { UserAvatar } from '@/components/display/UserAvatar';
import { DocumentCard, type DocumentSummary } from '@/components/documents/DocumentCard';
import { EmptyState } from '@/components/feedback/EmptyState';
import { DetailLayout } from '@/components/layout/DetailLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { RecordMenu, type RecordMenuItem } from '@/components/layout/RecordMenu';
import { RecordTabs } from '@/components/layout/RecordTabs';
import { PipelineStrip } from '@/components/pipeline/PipelineStrip';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { FollowUpSheet } from '@/components/timeline/FollowUpSheet';
import { Timeline } from '@/components/timeline/Timeline';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { istToday } from '@/lib/display';
import { EXTRACTION_STATUS_TEXT, formatBytes } from '@/lib/document-labels';
import { loadRecordAudit } from '@/lib/record-audit';
import { deletePurchaseOrderAction, restorePurchaseOrderAction } from '../actions';
import { loadPurchaseOrderOr404 } from '../load';
import { PurchaseOrderInvoices } from './PurchaseOrderInvoices';

/**
 * A purchase order (UI guide §4.2). No status actions: the status follows the PO's
 * invoices (M9 Decision 4), listed in the Invoices section (M10). The Document card reads
 * the client's PDF for review (M7).
 */
export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const po = await loadPurchaseOrderOr404(ctx, (await params).id);
  const { permissions, projectTotals: totals } = po;
  const deleted = po.deletedAt !== null;
  const canUpdate = !deleted && permissions.canUpdate;
  const label = `PO ${po.poNumber}`;
  const today = istToday();

  const query = {
    clientId: po.client.id,
    entityType: 'PURCHASE_ORDER' as const,
    entityId: po.id,
  };
  const [timeline, client, document, documents, audit, invoices] = await Promise.all([
    getClientTimeline(ctx, query),
    getClient(ctx, po.client.id),
    deleted ? null : getCurrentDocument(ctx, 'PURCHASE_ORDER', po.id),
    deleted ? null : listDocuments(ctx, { kind: ['PURCHASE_ORDER'], entityId: po.id }),
    loadRecordAudit(ctx, 'PurchaseOrder', po.id),
    deleted ? [] : listInvoicesForPurchaseOrder(ctx, po.id),
  ]);
  const contacts = client.contacts.map((c) => ({ id: c.id, name: c.name }));
  const canLog = !deleted && client.deletedAt === null;
  const documentSummary: DocumentSummary | null = document && {
    id: document.id,
    originalFilename: document.originalFilename,
    sizeBytes: document.sizeBytes,
    uploadedBy: document.uploadedBy.name,
    createdAt: document.createdAt.toISOString(),
    extractionStatus: document.extractionStatus,
    extractionError: document.extractionError,
    reviewStatus: document.reviewStatus,
    reviewedBy: document.reviewedBy?.name ?? null,
    reviewedAt: document.reviewedAt?.toISOString() ?? null,
    appliedFields: document.appliedFields,
  };

  const menu: RecordMenuItem[] = [];
  if (permissions.canDelete && !deleted) {
    menu.push({
      label: 'Delete',
      destructive: true,
      title: `Delete ${label}?`,
      description:
        'It disappears from the list and its project. You can restore it from the Deleted filter.',
      success: 'Purchase order deleted',
      run: async () => {
        'use server';
        return deletePurchaseOrderAction({ id: po.id });
      },
    });
  }
  if (permissions.deleteBlockedReason && !deleted) {
    menu.push({
      label: 'Delete',
      destructive: true,
      blocked: true,
      title: `${label} has invoices`,
      description: `Delete its invoices first (${po.billing.invoiceCount}). A PO with invoices cannot be deleted.`,
    });
  }
  if (permissions.canDelete && deleted) {
    menu.push({
      label: 'Restore',
      title: `Restore ${label}?`,
      description:
        'The PO comes back onto its project, if the client has no other PO with this number.',
      success: 'Purchase order restored',
      run: async () => {
        'use server';
        return restorePurchaseOrderAction({ id: po.id });
      },
    });
  }

  const coverage = (
    <span className="flex flex-col gap-1">
      <span>
        <Money amountMinor={totals.coveredMinor} currency={totals.currency} /> of{' '}
        <Money amountMinor={totals.revenueMinor} currency={totals.currency} /> revenue
      </span>
      {totals.byCurrency
        .filter((t) => t.currency !== totals.currency)
        .map((t) => (
          <span key={t.currency} className="text-muted-foreground text-[13px]">
            Plus <Money amountMinor={t.amountMinor} currency={t.currency} />
          </span>
        ))}
      {totals.overCovered && (
        <span className="text-foreground flex items-start gap-1.5 text-[13px]">
          <AlertTriangle className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
          Above the project revenue
        </span>
      )}
    </span>
  );

  const overview = (
    <>
      <Panel title="Details">
        <FieldGrid
          items={[
            { label: 'PO number', value: po.poNumber },
            { label: 'Received on', value: <DateDisplay value={po.receivedDate} /> },
            {
              label: 'Amount',
              value: (
                <Money
                  amountMinor={po.amountMinor}
                  currency={po.currency}
                  className="text-base font-medium"
                />
              ),
            },
            { label: 'Services', value: po.services.map((s) => s.name).join(', ') },
            {
              label: 'Payment terms',
              value: po.paymentTerms ?? <span className="text-muted-foreground">—</span>,
            },
            {
              label: 'Net days',
              value:
                po.paymentTermsDays === null ? (
                  <span className="text-muted-foreground">Company default</span>
                ) : (
                  <span className="num">{po.paymentTermsDays}</span>
                ),
            },
            {
              label: 'Scope and notes',
              value: <p className="whitespace-pre-line">{po.description}</p>,
              wide: true,
              hidden: !po.description,
            },
          ]}
        />
      </Panel>
      {deleted ? (
        <Panel>
          <p className="text-muted-foreground">Restore the PO to see its document.</p>
        </Panel>
      ) : (
        <DocumentCard
          kind="PURCHASE_ORDER"
          entityId={po.id}
          document={documentSummary}
          canUpdate={canUpdate}
          maxMb={Math.floor(getEnv().DOCUMENT_MAX_BYTES / (1024 * 1024))}
        />
      )}
      {!deleted && (
        <PurchaseOrderInvoices
          purchaseOrderId={po.id}
          today={today}
          canAdd={can(ctx.user, 'create', invoiceResource({ purchaseOrder: po }))}
          invoices={invoices.map((invoice) => ({
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate.toISOString(),
            dueDate: invoice.dueDate.toISOString(),
            amountMinor: invoice.amountMinor.toString(),
            currency: invoice.currency,
            status: invoice.status,
            documentState: invoice.documentState,
          }))}
          billing={{
            currency: po.billing.currency,
            poAmountMinor: po.billing.poAmountMinor.toString(),
            invoicedMinor: po.billing.invoicedMinor.toString(),
            paidMinor: po.billing.paidMinor.toString(),
            overInvoiced: po.billing.overInvoiced,
          }}
        />
      )}
    </>
  );

  const documentsTab = (
    <Panel bodyClassName="p-0">
      {!documents || documents.items.length === 0 ? (
        <EmptyState
          message={
            deleted
              ? 'Restore the PO to see its documents.'
              : 'No document yet. Upload the client’s PO on the Overview tab.'
          }
        />
      ) : (
        <ul className="divide-y">
          {documents.items.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
              <a
                className="font-medium hover:underline"
                href={`/api/documents/${d.id}/file`}
                target="_blank"
                rel="noreferrer"
              >
                {d.originalFilename}
              </a>
              <span className="text-muted-foreground num text-[13px]">
                {formatBytes(d.sizeBytes)}
              </span>
              <span className="text-muted-foreground text-[13px]">
                {d.uploadedBy.name} · <DateDisplay value={d.createdAt} withTime />
              </span>
              <span className="ml-auto text-[13px]">
                {d.reviewStatus === 'CONFIRMED'
                  ? 'Confirmed'
                  : EXTRACTION_STATUS_TEXT[d.extractionStatus]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Purchase orders', href: '/purchase-orders' },
          { label: po.poNumber },
        ]}
        title={label}
        description={`${po.client.name} — ${po.project.name}`}
        badge={
          <>
            <StatusBadge entity="po" status={po.status} />
            {deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
            <span className="text-muted-foreground text-[13px]">
              Status follows this PO’s invoices
            </span>
          </>
        }
        actions={
          <>
            {canLog && (
              <FollowUpSheet
                mode="create"
                triggerLabel="Log follow-up"
                triggerVariant="outline"
                targets={[{ entityType: 'PURCHASE_ORDER', entityId: po.id, label }]}
                contacts={contacts}
                today={today}
              />
            )}
            {canUpdate && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/purchase-orders/${po.id}/edit`}>Edit</Link>
              </Button>
            )}
            <RecordMenu label={label} items={menu} />
          </>
        }
      />
      <PipelineStrip
        current="po"
        reached={po.invoiceStage.count > 0 ? 'invoice' : 'po'}
        links={{
          enquiry: `/enquiries/${po.project.quotation.enquiry.id}`,
          quotation: `/quotations/${po.project.quotation.id}`,
          project: `/projects/${po.project.id}`,
          // The invoice when there is one, otherwise this PO's Invoices section (M10).
          invoice: po.invoiceStage.invoiceId
            ? `/invoices/${po.invoiceStage.invoiceId}`
            : '?tab=overview#invoices',
        }}
      />
      <DetailLayout
        main={
          <RecordTabs
            tabs={[
              { id: 'overview', label: 'Overview', content: overview },
              {
                id: 'timeline',
                label: 'Timeline',
                content: (
                  <Panel>
                    <Timeline
                      query={query}
                      initial={timeline}
                      me={{ id: ctx.user.id, isAdmin: can(ctx.user, 'list', 'user') }}
                      contacts={contacts}
                      today={today}
                      showRecord={false}
                    />
                  </Panel>
                ),
              },
              { id: 'documents', label: 'Documents', content: documentsTab },
              {
                id: 'audit',
                label: 'Audit',
                content: <RecordAudit rows={audit.rows} ownOnly={audit.ownOnly} />,
              },
            ]}
          />
        }
        side={
          <Panel title="Key facts">
            <FieldGrid
              columns={1}
              items={[
                {
                  label: 'Client',
                  value: (
                    <Link className="hover:underline" href={`/clients/${po.client.id}`}>
                      {po.client.name}
                    </Link>
                  ),
                },
                {
                  label: 'Project',
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <Link className="hover:underline" href={`/projects/${po.project.id}`}>
                        {po.project.number}
                      </Link>
                      <StatusBadge entity="project" status={po.project.status} />
                    </span>
                  ),
                },
                {
                  label: 'Project manager',
                  value: po.project.manager ? (
                    <UserAvatar name={po.project.manager.name} showName />
                  ) : (
                    <span className="text-muted-foreground">Unassigned</span>
                  ),
                },
                {
                  label: 'Pipeline owner',
                  value: <UserAvatar name={po.project.quotation.owner.name} showName />,
                },
                {
                  label: 'Amount',
                  value: <Money amountMinor={po.amountMinor} currency={po.currency} />,
                },
                { label: 'Received on', value: <DateDisplay value={po.receivedDate} /> },
                {
                  label: 'Payment terms',
                  value: po.paymentTerms,
                  hidden: !po.paymentTerms,
                },
                {
                  label: 'POs on this project',
                  value: coverage,
                  hidden: deleted,
                },
                {
                  label: 'Document',
                  value: document ? (
                    document.originalFilename
                  ) : (
                    <span className="text-muted-foreground">None yet</span>
                  ),
                  hidden: deleted,
                },
                {
                  label: 'Status changed',
                  value: <DateDisplay value={po.statusChangedAt} withTime />,
                  hidden: !po.statusChangedAt,
                },
                { label: 'Created', value: <DateDisplay value={po.createdAt} withTime /> },
                { label: 'Updated', value: <DateDisplay value={po.updatedAt} withTime /> },
              ]}
            />
          </Panel>
        }
      />
    </>
  );
}
