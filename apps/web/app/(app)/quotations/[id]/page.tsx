import {
  can,
  getClient,
  getClientTimeline,
  getCurrentDocument,
  getEnv,
  getLatestFollowUp,
  quotationResource,
} from '@sales-tracker/core';
import { toAmountString, toCalendarDateString } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { RecordAudit } from '@/components/audit/RecordAudit';
import { Panel } from '@/components/charts/Panel';
import { DateDisplay } from '@/components/display/DateDisplay';
import { FieldGrid } from '@/components/display/FieldGrid';
import { Money } from '@/components/display/Money';
import { RelativeDue } from '@/components/display/RelativeDue';
import { UserAvatar } from '@/components/display/UserAvatar';
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
import { formatDate } from '@/lib/format';
import { isOpenQuotation } from '@/lib/quotation-labels';
import { loadRecordAudit } from '@/lib/record-audit';
import { deleteQuotationAction, restoreQuotationAction } from '../actions';
import { loadQuotationFormOptions } from '../form-options';
import { loadQuotationOr404 } from '../load';
import { EditQuotationButton } from '../QuotationSheets';
import { DocumentCard, type DocumentSummary } from './DocumentCard';
import { StatusDialog } from './StatusActions';

export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const quotation = await loadQuotationOr404(ctx, (await params).id);
  const resource = quotationResource(quotation);
  const deleted = quotation.deletedAt !== null;
  const canUpdate = !deleted && can(ctx.user, 'update', resource);
  const canDelete = can(ctx.user, 'delete', resource);
  const open = isOpenQuotation(quotation.status);
  const won = quotation.status === 'PO_RECEIVED';
  const today = istToday();
  const quotationDate = toCalendarDateString(quotation.quotationDate);
  const next = quotation.nextFollowUpDate ? toCalendarDateString(quotation.nextFollowUpDate) : '';

  const query = {
    clientId: quotation.client.id,
    entityType: 'QUOTATION' as const,
    entityId: quotation.id,
  };
  const [timeline, latest, client, document, audit, editOptions] = await Promise.all([
    getClientTimeline(ctx, query),
    getLatestFollowUp(ctx, 'QUOTATION', quotation.id),
    getClient(ctx, quotation.client.id),
    deleted ? null : getCurrentDocument(ctx, 'QUOTATION', quotation.id),
    loadRecordAudit(ctx, 'Quotation', quotation.id),
    canUpdate ? loadQuotationFormOptions(ctx, quotation) : null,
  ]);
  const contacts = client.contacts.map((c) => ({ id: c.id, name: c.name }));
  const canLog = !deleted && client.deletedAt === null;
  const synced = latest && latest.id === quotation.lastFollowUpId ? latest : null;
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
  const status = (to: 'SENT' | 'UNDER_NEGOTIATION' | 'PO_RECEIVED' | 'LOST') => (
    <StatusDialog
      id={quotation.id}
      to={to}
      nextFollowUpDate={next}
      quotationDate={quotationDate}
      today={today}
      variant={to === 'PO_RECEIVED' ? 'default' : 'outline'}
    />
  );

  const menu: RecordMenuItem[] = [];
  if (canDelete && !deleted && !won) {
    menu.push({
      label: 'Delete',
      destructive: true,
      title: `Delete ${quotation.number}?`,
      description: 'It disappears from the list. You can restore it from the Deleted filter.',
      success: 'Quotation deleted',
      run: async () => {
        'use server';
        return deleteQuotationAction({ id: quotation.id });
      },
    });
  }
  if (canDelete && deleted) {
    menu.push({
      label: 'Restore',
      title: `Restore ${quotation.number}?`,
      description: 'The quotation comes back into the list.',
      success: 'Quotation restored',
      run: async () => {
        'use server';
        return restoreQuotationAction({ id: quotation.id });
      },
    });
  }

  const overview = (
    <>
      {won && !deleted && (
        <div
          role="status"
          className="bg-success-soft flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border p-4"
        >
          <p>
            PO received on <DateDisplay value={quotation.poReceivedDate} />. Set up the project
            next.
          </p>
          <Button asChild size="sm">
            <Link href={`/projects/new?quotationId=${quotation.id}`}>Create project</Link>
          </Button>
        </div>
      )}
      <Panel title="Details">
        <FieldGrid
          items={[
            {
              label: 'Amount',
              value: (
                <Money
                  amountMinor={quotation.amountMinor}
                  currency={quotation.currency}
                  className="text-base font-medium"
                />
              ),
            },
            { label: 'Quotation date', value: <DateDisplay value={quotation.quotationDate} /> },
            { label: 'Sector', value: quotation.sector.name },
            { label: 'Services', value: quotation.services.map((s) => s.name).join(', ') },
            {
              label: 'PO received on',
              value: <DateDisplay value={quotation.poReceivedDate} />,
              hidden: !quotation.poReceivedDate,
            },
            {
              label: 'Lost because',
              value: quotation.lostReason,
              hidden: !quotation.lostReason,
              wide: true,
            },
            {
              label: synced
                ? `Follow-up highlights (from ${formatDate(synced.date)})`
                : 'Follow-up highlights',
              value: <p className="whitespace-pre-line">{quotation.lastFollowUpHighlights}</p>,
              wide: true,
              hidden: !quotation.lastFollowUpHighlights,
            },
            {
              label: 'Scope and notes',
              value: <p className="whitespace-pre-line">{quotation.description}</p>,
              wide: true,
              hidden: !quotation.description,
            },
          ]}
        />
      </Panel>
    </>
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Quotations', href: '/quotations' }, { label: quotation.number }]}
        title={quotation.number}
        description={`${quotation.client.name} · ${quotation.services.map((s) => s.name).join(', ')}`}
        badge={
          <>
            <StatusBadge entity="quotation" status={quotation.status} />
            {deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
          </>
        }
        actions={
          <>
            {canLog && (
              <FollowUpSheet
                mode="create"
                triggerLabel="Log follow-up"
                triggerVariant="outline"
                targets={[
                  { entityType: 'QUOTATION', entityId: quotation.id, label: quotation.number },
                ]}
                contacts={contacts}
                today={today}
                nextRequired={open}
              />
            )}
            {canUpdate && editOptions && (
              <EditQuotationButton
                quotation={{ id: quotation.id, number: quotation.number }}
                closed={!open}
                client={quotation.client.name}
                options={editOptions}
                today={today}
                initial={{
                  enquiryId: quotation.enquiryId,
                  quotationDate,
                  amount: toAmountString(quotation.amountMinor, quotation.currency),
                  currency: quotation.currency,
                  sectorId: quotation.sectorId,
                  serviceIds: quotation.services.map((s) => s.id),
                  nextFollowUpDate: next,
                  description: quotation.description ?? '',
                  lastFollowUpHighlights: quotation.lastFollowUpHighlights ?? '',
                  ownerId: quotation.ownerId,
                }}
              />
            )}
            {canUpdate && quotation.status === 'SENT' && status('UNDER_NEGOTIATION')}
            {canUpdate && quotation.status === 'UNDER_NEGOTIATION' && status('SENT')}
            {canUpdate && open && status('LOST')}
            {canUpdate && open && status('PO_RECEIVED')}
            <RecordMenu label={quotation.number} items={menu} />
          </>
        }
      />
      <PipelineStrip
        current="quotation"
        links={{ enquiry: `/enquiries/${quotation.enquiry.id}` }}
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
              {
                id: 'documents',
                label: 'Documents',
                content: deleted ? (
                  <Panel>
                    <p className="text-muted-foreground">
                      Restore the quotation to see its document.
                    </p>
                  </Panel>
                ) : (
                  <DocumentCard
                    kind="QUOTATION"
                    entityId={quotation.id}
                    document={documentSummary}
                    canUpdate={canUpdate}
                    maxMb={Math.floor(getEnv().DOCUMENT_MAX_BYTES / (1024 * 1024))}
                  />
                ),
              },
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
                    <Link className="hover:underline" href={`/clients/${quotation.client.id}`}>
                      {quotation.client.name}
                    </Link>
                  ),
                },
                { label: 'Owner', value: <UserAvatar name={quotation.owner.name} showName /> },
                {
                  label: 'Amount',
                  value: (
                    <Money amountMinor={quotation.amountMinor} currency={quotation.currency} />
                  ),
                },
                {
                  label: 'Next follow-up',
                  value: (
                    <RelativeDue
                      date={quotation.nextFollowUpDate}
                      today={today}
                      active={open && !deleted}
                    />
                  ),
                  hidden: !open,
                },
                {
                  label: 'Enquiry',
                  value: (
                    <Link className="hover:underline" href={`/enquiries/${quotation.enquiry.id}`}>
                      {quotation.enquiry.number}
                    </Link>
                  ),
                },
                {
                  label: 'Document',
                  value: document ? (
                    <Link className="hover:underline" href="?tab=documents">
                      {document.originalFilename}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">None yet</span>
                  ),
                  hidden: deleted,
                },
                {
                  label: 'Status changed',
                  value: <DateDisplay value={quotation.statusChangedAt} withTime />,
                  hidden: !quotation.statusChangedAt,
                },
                { label: 'Created', value: <DateDisplay value={quotation.createdAt} withTime /> },
                { label: 'Updated', value: <DateDisplay value={quotation.updatedAt} withTime /> },
              ]}
            />
          </Panel>
        }
      />
    </>
  );
}
