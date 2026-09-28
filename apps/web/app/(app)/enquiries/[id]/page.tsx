import {
  can,
  enquiryResource,
  getClient,
  getClientTimeline,
  getLatestFollowUp,
  getQuotationDraft,
  listQuotationsForEnquiry,
} from '@sales-tracker/core';
import { toCalendarDateString } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { RecordAudit } from '@/components/audit/RecordAudit';
import { Panel } from '@/components/charts/Panel';
import { DateDisplay } from '@/components/display/DateDisplay';
import { FieldGrid } from '@/components/display/FieldGrid';
import { Money } from '@/components/display/Money';
import { RelativeDue } from '@/components/display/RelativeDue';
import { UserAvatar } from '@/components/display/UserAvatar';
import { EmptyState } from '@/components/feedback/EmptyState';
import { DetailLayout } from '@/components/layout/DetailLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { RecordMenu, type RecordMenuItem } from '@/components/layout/RecordMenu';
import { RecordTabs } from '@/components/layout/RecordTabs';
import { PipelineStrip } from '@/components/pipeline/PipelineStrip';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { FollowUpSheet } from '@/components/timeline/FollowUpSheet';
import { Timeline } from '@/components/timeline/Timeline';
import { requireUser } from '@/lib/auth';
import { istToday } from '@/lib/display';
import { SOURCE_DETAIL, SOURCE_LABELS } from '@/lib/enquiry-labels';
import { loadRecordAudit } from '@/lib/record-audit';
import { loadQuotationFormOptions } from '../../quotations/form-options';
import { CreateQuotationButton } from '../../quotations/QuotationSheets';
import { deleteEnquiryAction, restoreEnquiryAction } from '../actions';
import { EditEnquiryButton } from '../EnquirySheets';
import { loadEnquiryFormOptions } from '../form-options';
import { loadEnquiryOr404 } from '../load';
import { ConvertDialog, MarkLostDialog } from './StatusActions';

export default async function EnquiryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const enquiry = await loadEnquiryOr404(ctx, (await params).id);
  const resource = enquiryResource(enquiry);
  const deleted = enquiry.deletedAt !== null;
  const canUpdate = !deleted && can(ctx.user, 'update', resource);
  const canDelete = can(ctx.user, 'delete', resource);
  const converted = enquiry.status === 'CONVERTED';
  const inProgress = enquiry.status === 'IN_PROGRESS';
  const canQuote = !deleted && converted && can(ctx.user, 'create', 'quotation');
  const today = istToday();

  // The enquiry's own slice of the client timeline (M5).
  const query = {
    clientId: enquiry.client.id,
    entityType: 'ENQUIRY' as const,
    entityId: enquiry.id,
  };
  const [timeline, latest, client, quotations, audit, editOptions, quoteOptions, draft] =
    await Promise.all([
      getClientTimeline(ctx, query),
      getLatestFollowUp(ctx, 'ENQUIRY', enquiry.id),
      getClient(ctx, enquiry.client.id),
      converted && !deleted ? listQuotationsForEnquiry(ctx, enquiry.id) : [],
      loadRecordAudit(ctx, 'Enquiry', enquiry.id),
      canUpdate ? loadEnquiryFormOptions(ctx, enquiry) : null,
      canQuote ? loadQuotationFormOptions(ctx) : null,
      canQuote ? getQuotationDraft(ctx, enquiry.id).catch(() => null) : null,
    ]);
  const contacts = client.contacts.map((c) => ({ id: c.id, name: c.name }));
  const canLog = !deleted && client.deletedAt === null;
  const latestQuotation = quotations[0];
  // The pipeline strip links a project only when there is exactly one under the enquiry.
  const projects = quotations.flatMap((q) => q.projects);
  const onlyProject = projects.length === 1 ? projects[0] : undefined;
  // M9: likewise the PO; with several, the one project's PO section.
  const purchaseOrders = projects.flatMap((p) => p.purchaseOrders);
  const poLink =
    purchaseOrders.length === 1
      ? `/purchase-orders/${purchaseOrders[0]!.id}`
      : onlyProject && `/projects/${onlyProject.id}?tab=overview#purchase-orders`;

  const menu: RecordMenuItem[] = [];
  if (canDelete && !deleted && !converted) {
    menu.push({
      label: 'Delete',
      destructive: true,
      title: `Delete ${enquiry.number}?`,
      description: 'It disappears from the list. You can restore it from the Deleted filter.',
      success: 'Enquiry deleted',
      run: async () => {
        'use server';
        return deleteEnquiryAction({ id: enquiry.id });
      },
    });
  }
  if (canDelete && deleted) {
    menu.push({
      label: 'Restore',
      title: `Restore ${enquiry.number}?`,
      description: 'The enquiry comes back into the list.',
      success: 'Enquiry restored',
      run: async () => {
        'use server';
        return restoreEnquiryAction({ id: enquiry.id });
      },
    });
  }

  const overview = (
    <>
      <Panel title="Details">
        <FieldGrid
          items={[
            { label: 'Sector', value: enquiry.sector.name },
            { label: 'Services', value: enquiry.services.map((s) => s.name).join(', ') },
            { label: 'Source', value: SOURCE_LABELS[enquiry.source] },
            {
              label: SOURCE_DETAIL[enquiry.source].label,
              value: enquiry.sourceDetail,
              hidden: !enquiry.sourceDetail,
            },
            { label: 'Received on', value: <DateDisplay value={enquiry.receivedDate} /> },
            { label: 'Proposal sent on', value: <DateDisplay value={enquiry.proposalSentDate} /> },
            {
              label: 'What they asked for',
              value: <p className="whitespace-pre-line">{enquiry.description}</p>,
              wide: true,
              hidden: !enquiry.description,
            },
            {
              label: 'Lost because',
              value: enquiry.lostReason,
              wide: true,
              hidden: !enquiry.lostReason,
            },
          ]}
        />
      </Panel>
      {converted && !deleted && (
        <Panel title="Quotations" bodyClassName="p-0">
          {quotations.length === 0 ? (
            <EmptyState message="No quotations yet. Create the first one from this enquiry." />
          ) : (
            <ul className="divide-y">
              {quotations.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                  <Link className="font-medium hover:underline" href={`/quotations/${q.id}`}>
                    {q.number}
                  </Link>
                  <DateDisplay value={q.quotationDate} className="text-muted-foreground" />
                  <StatusBadge entity="quotation" status={q.status} />
                  {q.projects.map((p) => (
                    <Link
                      key={p.id}
                      className="text-muted-foreground text-[13px] hover:underline"
                      href={`/projects/${p.id}`}
                    >
                      {p.number}
                    </Link>
                  ))}
                  <Money amountMinor={q.amountMinor} currency={q.currency} className="ml-auto" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Enquiries', href: '/enquiries' }, { label: enquiry.number }]}
        title={enquiry.number}
        description={`${enquiry.client.name} · ${enquiry.services.map((s) => s.name).join(', ')}`}
        badge={
          <>
            <StatusBadge entity="enquiry" status={enquiry.status} />
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
                targets={[{ entityType: 'ENQUIRY', entityId: enquiry.id, label: enquiry.number }]}
                contacts={contacts}
                today={today}
              />
            )}
            {canUpdate && editOptions && (
              <EditEnquiryButton
                options={editOptions}
                today={today}
                enquiry={{
                  id: enquiry.id,
                  number: enquiry.number,
                  clientId: enquiry.clientId,
                  sectorId: enquiry.sectorId,
                  serviceIds: enquiry.services.map((s) => s.id),
                  receivedDate: toCalendarDateString(enquiry.receivedDate),
                  proposalSentDate: enquiry.proposalSentDate
                    ? toCalendarDateString(enquiry.proposalSentDate)
                    : '',
                  source: enquiry.source,
                  sourceDetail: enquiry.sourceDetail ?? '',
                  description: enquiry.description ?? '',
                  ownerId: enquiry.ownerId,
                }}
              />
            )}
            {canUpdate && inProgress && (
              <>
                <MarkLostDialog id={enquiry.id} />
                <ConvertDialog
                  id={enquiry.id}
                  receivedDate={toCalendarDateString(enquiry.receivedDate)}
                  proposalSentDate={
                    enquiry.proposalSentDate ? toCalendarDateString(enquiry.proposalSentDate) : ''
                  }
                  today={today}
                />
              </>
            )}
            {canQuote && quoteOptions && draft && (
              <CreateQuotationButton
                enquiryNumber={enquiry.number}
                client={enquiry.client.name}
                options={quoteOptions}
                today={today}
                initial={{
                  enquiryId: draft.enquiryId,
                  quotationDate: toCalendarDateString(draft.quotationDate),
                  amount: '',
                  currency: quoteOptions.currencies.includes('INR')
                    ? 'INR'
                    : (quoteOptions.currencies[0] ?? 'INR'),
                  sectorId: draft.sectorId,
                  serviceIds: draft.serviceIds,
                  nextFollowUpDate: '',
                  description: '',
                  lastFollowUpHighlights: '',
                  ownerId: draft.ownerId,
                }}
              />
            )}
            <RecordMenu label={enquiry.number} items={menu} />
          </>
        }
      />
      <PipelineStrip
        current="enquiry"
        reached={
          purchaseOrders.length > 0
            ? 'po'
            : projects.length > 0
              ? 'project'
              : latestQuotation
                ? 'quotation'
                : 'enquiry'
        }
        links={{
          ...(latestQuotation && { quotation: `/quotations/${latestQuotation.id}` }),
          ...(onlyProject && { project: `/projects/${onlyProject.id}` }),
          ...(purchaseOrders.length > 0 && poLink && { po: poLink }),
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
              {
                id: 'documents',
                label: 'Documents',
                content: (
                  <Panel>
                    <EmptyState message="Enquiries don’t carry documents. Attach them to the quotation, PO or invoice." />
                  </Panel>
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
          <>
            <Panel title="Key facts">
              <FieldGrid
                columns={1}
                items={[
                  {
                    label: 'Client',
                    value: (
                      <Link className="hover:underline" href={`/clients/${enquiry.client.id}`}>
                        {enquiry.client.name}
                      </Link>
                    ),
                  },
                  { label: 'Owner', value: <UserAvatar name={enquiry.owner.name} showName /> },
                  {
                    label: 'Next follow-up',
                    value: (
                      <RelativeDue
                        date={latest?.nextFollowUpDate}
                        today={today}
                        active={inProgress && !deleted}
                      />
                    ),
                  },
                  {
                    label: 'Status changed',
                    value: <DateDisplay value={enquiry.statusChangedAt} withTime />,
                    hidden: !enquiry.statusChangedAt,
                  },
                  { label: 'Created', value: <DateDisplay value={enquiry.createdAt} withTime /> },
                  { label: 'Updated', value: <DateDisplay value={enquiry.updatedAt} withTime /> },
                ]}
              />
            </Panel>
            {quotations.length > 0 && (
              <Panel title="Linked records" bodyClassName="flex flex-col gap-2">
                {quotations.map((q) => (
                  <Link
                    key={q.id}
                    href={`/quotations/${q.id}`}
                    className="flex items-center justify-between gap-2 hover:underline"
                  >
                    <span>{q.number}</span>
                    <StatusBadge entity="quotation" status={q.status} />
                  </Link>
                ))}
              </Panel>
            )}
          </>
        }
      />
    </>
  );
}
