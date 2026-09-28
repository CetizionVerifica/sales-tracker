import {
  can,
  getClient,
  getClientTimeline,
  getCurrentDocument,
  getEnv,
  invoiceResource,
  listDocuments,
} from '@sales-tracker/core';
import { toCalendarDateString } from '@sales-tracker/core/schemas';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { RecordAudit } from '@/components/audit/RecordAudit';
import { Panel } from '@/components/charts/Panel';
import { DateDisplay } from '@/components/display/DateDisplay';
import { FieldGrid } from '@/components/display/FieldGrid';
import { InrEquivalent } from '@/components/display/InrEquivalent';
import { Money } from '@/components/display/Money';
import { RelativeDue } from '@/components/display/RelativeDue';
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
import { DUE_DATE_BASIS_LABELS } from '@/lib/invoice-labels';
import { loadRecordAudit } from '@/lib/record-audit';
import { deleteInvoiceAction, restoreInvoiceAction } from '../actions';
import { loadInvoiceOr404 } from '../load';
import { MarkPaidDialog, MarkUnpaidDialog } from '@/components/invoices/PaymentDialogs';

/**
 * An invoice (UI guide §4.2). Mark paid is the one user-chosen status move (Decision 14);
 * overdue follows the due date (Decision 7), and admins can reverse a payment (Decision 8).
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const invoice = await loadInvoiceOr404(ctx, (await params).id);
  const { permissions, billing } = invoice;
  const po = invoice.purchaseOrder;
  const deleted = invoice.deletedAt !== null;
  const label = `Invoice ${invoice.invoiceNumber}`;
  const today = istToday();
  const unpaid = invoice.status !== 'PAID';

  const query = {
    clientId: invoice.client.id,
    entityType: 'INVOICE' as const,
    entityId: invoice.id,
  };
  const [timeline, client, document, documents, audit] = await Promise.all([
    getClientTimeline(ctx, query),
    getClient(ctx, invoice.client.id),
    deleted ? null : getCurrentDocument(ctx, 'INVOICE', invoice.id),
    deleted ? null : listDocuments(ctx, { kind: ['INVOICE'], entityId: invoice.id }),
    loadRecordAudit(ctx, 'Invoice', invoice.id),
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
  if (!deleted && permissions.canDelete) {
    menu.push({
      label: 'Delete',
      destructive: true,
      title: `Delete invoice ${invoice.invoiceNumber}?`,
      description:
        'It disappears from the list and its PO, and the PO’s status is worked out again. You can restore it from the Deleted filter.',
      success: 'Invoice deleted',
      run: async () => {
        'use server';
        return deleteInvoiceAction({ id: invoice.id });
      },
    });
  }
  if (!deleted && permissions.deleteBlockedReason) {
    menu.push({
      label: 'Delete',
      destructive: true,
      blocked: true,
      title: `Delete invoice ${invoice.invoiceNumber}?`,
      description: `${permissions.deleteBlockedReason}. Ask an admin to mark it unpaid first, or to delete it.`,
    });
  }
  if (deleted && can(ctx.user, 'delete', invoiceResource(invoice))) {
    menu.push({
      label: 'Restore',
      title: `Restore invoice ${invoice.invoiceNumber}?`,
      description: 'The invoice comes back onto its PO, if no other invoice has this number.',
      success: 'Invoice restored',
      run: async () => {
        'use server';
        return restoreInvoiceAction({ id: invoice.id });
      },
    });
  }

  const billingLine = (
    <span className="flex flex-col gap-1">
      <span>
        Invoiced <Money amountMinor={billing.invoicedMinor} currency={billing.currency} /> of{' '}
        <Money amountMinor={billing.poAmountMinor} currency={billing.currency} />
      </span>
      <span className="text-muted-foreground text-[13px]">
        Paid <Money amountMinor={billing.paidMinor} currency={billing.currency} />
      </span>
      {billing.overInvoiced && (
        <span className="text-foreground flex items-start gap-1.5 text-[13px]">
          <AlertTriangle className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
          Above the PO amount
        </span>
      )}
    </span>
  );

  const overview = (
    <>
      <Panel title="Details">
        <FieldGrid
          items={[
            { label: 'Invoice number', value: invoice.invoiceNumber },
            { label: 'Invoice date', value: <DateDisplay value={invoice.invoiceDate} /> },
            { label: 'Service', value: invoice.service.name },
            {
              label: 'Amount',
              value: (
                <Money
                  amountMinor={invoice.amountMinor}
                  currency={invoice.currency}
                  className="text-base font-medium"
                />
              ),
            },
            {
              label: 'Due date',
              value: (
                <span className="flex flex-col gap-0.5">
                  <RelativeDue date={invoice.dueDate} today={today} active={unpaid && !deleted} />
                  <span className="text-muted-foreground text-[13px]">
                    {DUE_DATE_BASIS_LABELS[invoice.dueDateBasis]}
                  </span>
                </span>
              ),
            },
            {
              label: 'Paid on',
              value: <DateDisplay value={invoice.paidAt} />,
              hidden: !invoice.paidAt,
            },
            {
              label: 'Payment reference',
              value: invoice.paymentReference,
              hidden: !invoice.paymentReference,
            },
            {
              label: 'Payment reversed',
              value: invoice.unmarkedPaidReason,
              hidden: !invoice.unmarkedPaidReason || !unpaid,
              wide: true,
            },
            {
              label: 'Notes',
              value: <p className="whitespace-pre-line">{invoice.description}</p>,
              wide: true,
              hidden: !invoice.description,
            },
          ]}
        />
      </Panel>
      {deleted ? (
        <Panel>
          <p className="text-muted-foreground">Restore the invoice to see its document.</p>
        </Panel>
      ) : (
        <DocumentCard
          kind="INVOICE"
          entityId={invoice.id}
          document={documentSummary}
          canUpdate={permissions.canUpdate}
          maxMb={Math.floor(getEnv().DOCUMENT_MAX_BYTES / (1024 * 1024))}
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
              ? 'Restore the invoice to see its documents.'
              : 'No document yet. Upload the invoice on the Overview tab.'
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
        breadcrumbs={[{ label: 'Invoices', href: '/invoices' }, { label: invoice.invoiceNumber }]}
        title={label}
        description={`${invoice.client.name} — PO ${po.poNumber}`}
        badge={
          <>
            <StatusBadge entity="invoice" status={invoice.status} />
            {deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
          </>
        }
        actions={
          <>
            {permissions.canMarkPaid && (
              <MarkPaidDialog
                id={invoice.id}
                label={`invoice ${invoice.invoiceNumber}`}
                invoiceDate={toCalendarDateString(invoice.invoiceDate)}
                today={today}
              />
            )}
            {permissions.canMarkUnpaid && (
              <MarkUnpaidDialog id={invoice.id} label={`invoice ${invoice.invoiceNumber}`} />
            )}
            {canLog && (
              <FollowUpSheet
                mode="create"
                triggerLabel="Log follow-up"
                triggerVariant="outline"
                targets={[{ entityType: 'INVOICE', entityId: invoice.id, label }]}
                contacts={contacts}
                today={today}
              />
            )}
            {permissions.canUpdate && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/invoices/${invoice.id}/edit`}>Edit</Link>
              </Button>
            )}
            <RecordMenu label={label} items={menu} />
          </>
        }
      />
      <PipelineStrip
        current="invoice"
        links={{
          enquiry: `/enquiries/${po.project.quotation.enquiry.id}`,
          quotation: `/quotations/${po.project.quotation.id}`,
          project: `/projects/${po.project.id}`,
          po: `/purchase-orders/${po.id}`,
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
                    <Link className="hover:underline" href={`/clients/${invoice.client.id}`}>
                      {invoice.client.name}
                    </Link>
                  ),
                },
                {
                  label: 'Purchase order',
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <Link className="hover:underline" href={`/purchase-orders/${po.id}`}>
                        PO {po.poNumber}
                      </Link>
                      <StatusBadge entity="po" status={po.status} />
                    </span>
                  ),
                },
                {
                  label: 'Project',
                  value: (
                    <Link className="hover:underline" href={`/projects/${po.project.id}`}>
                      {po.project.number} · {po.project.name}
                    </Link>
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
                  value: (
                    <>
                      <Money amountMinor={invoice.amountMinor} currency={invoice.currency} />
                      <InrEquivalent
                        currency={invoice.currency}
                        amountInrMinor={invoice.amountInrMinor}
                        fxRate={invoice.fxRate}
                        date={invoice.invoiceDate}
                      />
                    </>
                  ),
                },
                {
                  label: 'Due',
                  value: (
                    <RelativeDue date={invoice.dueDate} today={today} active={unpaid && !deleted} />
                  ),
                },
                { label: 'This PO', value: billingLine, hidden: deleted },
                {
                  label: 'Status changed',
                  value: <DateDisplay value={invoice.statusChangedAt} withTime />,
                  hidden: !invoice.statusChangedAt,
                },
                { label: 'Created', value: <DateDisplay value={invoice.createdAt} withTime /> },
                { label: 'Updated', value: <DateDisplay value={invoice.updatedAt} withTime /> },
              ]}
            />
          </Panel>
        }
      />
    </>
  );
}
