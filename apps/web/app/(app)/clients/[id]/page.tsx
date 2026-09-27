import {
  can,
  getClient,
  getClientTimeline,
  listDocuments,
  listEnquiries,
  listFollowUpTargets,
  listProjects,
  listQuotations,
  NotFoundError,
} from '@sales-tracker/core';
import { clientTimelineSchema } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { FilterBar } from '@/components/data/FilterBar';
import { DateDisplay } from '@/components/display/DateDisplay';
import { FieldGrid } from '@/components/display/FieldGrid';
import { Money } from '@/components/display/Money';
import { Progress } from '@/components/display/Progress';
import { EmptyState } from '@/components/feedback/EmptyState';
import { DetailLayout } from '@/components/layout/DetailLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { RecordTabs } from '@/components/layout/RecordTabs';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { FollowUpSheet } from '@/components/timeline/FollowUpSheet';
import { Timeline, type TimelineQuery } from '@/components/timeline/Timeline';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { istToday } from '@/lib/display';
import { EXTRACTION_STATUS_TEXT, formatBytes } from '@/lib/document-labels';
import { ENTITY_TYPE_LABELS, KIND_LABELS } from '@/lib/follow-up-labels';
import type { SearchParams } from '@/lib/list-params';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** URL filters → timeline query; a hand-edited URL falls back to the unfiltered timeline. */
function timelineQuery(clientId: string, params: SearchParams): TimelineQuery {
  const [entityType, entityId] = (first(params.record) ?? '').split(':');
  const parsed = clientTimelineSchema.safeParse({
    clientId,
    kinds: first(params.kinds),
    ...(entityType && entityId && { entityType, entityId }),
  });
  if (!parsed.success) return { clientId };
  const { kinds, entityType: type, entityId: id } = parsed.data;
  return { clientId, kinds, entityType: type, entityId: id };
}

/** A client (UI guide §4.2): Overview, Pipeline, Timeline, Documents; no pipeline strip. */
export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  const { id } = await params;
  const isAdmin = can(ctx.user, 'list', 'user');
  const client = await getClient(ctx, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  // Deleted clients are for admins only (M5 spec).
  if (client.deletedAt && !isAdmin) notFound();
  const deleted = client.deletedAt !== null;

  const search = await searchParams;
  const query = timelineQuery(client.id, search);
  const [timeline, targets, enquiries, quotations, projects, documents] = await Promise.all([
    getClientTimeline(ctx, query).catch((error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    }),
    deleted ? [] : listFollowUpTargets(ctx, client.id),
    listEnquiries(ctx, { clientId: client.id, pageSize: 10 }),
    listQuotations(ctx, { clientId: client.id, pageSize: 10 }),
    listProjects(ctx, { clientId: client.id, pageSize: 10 }),
    listDocuments(ctx, { clientId: client.id, pageSize: 25 }),
  ]);
  const primary = client.contacts.find((c) => c.isPrimary);
  const contacts = client.contacts.map((c) => ({ id: c.id, name: c.name }));
  const today = istToday();
  const timelineFiltered = Boolean(first(search.kinds) || first(search.record));

  const overview = (
    <>
      <Panel title="Details">
        <FieldGrid
          items={[
            { label: 'Sector', value: client.sector.name },
            { label: 'GSTIN', value: client.gstin ?? '—' },
            { label: 'Address', value: client.address, wide: true, hidden: !client.address },
            { label: 'Notes', value: client.notes, wide: true, hidden: !client.notes },
          ]}
        />
      </Panel>
      <Panel title="Contacts" bodyClassName="p-0">
        {client.contacts.length === 0 ? (
          <EmptyState message="No contacts yet. An admin can add them from the client record." />
        ) : (
          <ul className="divide-y">
            {client.contacts.map((c) => (
              <li key={c.id} className="flex flex-col gap-0.5 px-4 py-2.5">
                <span className="flex items-center gap-2 font-medium">
                  {c.name}
                  {c.isPrimary && <MarkBadge tone="primary">Primary</MarkBadge>}
                </span>
                <span className="text-muted-foreground text-[13px]">
                  {[c.designation, c.phone, c.email].filter(Boolean).join(' · ') || '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );

  const pipeline = (
    <>
      <Panel
        title="Enquiries"
        bodyClassName="p-0"
        actions={
          enquiries.total > enquiries.items.length && (
            <Link
              className="text-primary text-[13px] hover:underline"
              href={`/enquiries?clientId=${client.id}`}
            >
              All {enquiries.total} enquiries
            </Link>
          )
        }
      >
        {enquiries.items.length === 0 ? (
          <EmptyState message="No enquiries you can see for this client." />
        ) : (
          <ul className="divide-y">
            {enquiries.items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                <Link className="font-medium hover:underline" href={`/enquiries/${e.id}`}>
                  {e.number}
                </Link>
                <StatusBadge entity="enquiry" status={e.status} />
                <span className="text-muted-foreground ml-auto text-[13px]">
                  Received <DateDisplay value={e.receivedDate} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel
        title="Quotations"
        bodyClassName="p-0"
        actions={
          quotations.total > quotations.items.length && (
            <Link
              className="text-primary text-[13px] hover:underline"
              href={`/quotations?clientId=${client.id}`}
            >
              All {quotations.total} quotations
            </Link>
          )
        }
      >
        {quotations.items.length === 0 ? (
          <EmptyState message="No quotations you can see for this client." />
        ) : (
          <ul className="divide-y">
            {quotations.items.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                <Link className="font-medium hover:underline" href={`/quotations/${q.id}`}>
                  {q.number}
                </Link>
                <StatusBadge entity="quotation" status={q.status} />
                <Money amountMinor={q.amountMinor} currency={q.currency} className="ml-auto" />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel
        title="Projects"
        bodyClassName="p-0"
        actions={
          projects.total > projects.items.length && (
            <Link
              className="text-primary text-[13px] hover:underline"
              href={`/projects?clientId=${client.id}`}
            >
              All {projects.total} projects
            </Link>
          )
        }
      >
        {projects.items.length === 0 ? (
          <EmptyState message="No projects you can see for this client." />
        ) : (
          <ul className="divide-y">
            {projects.items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                <Link className="font-medium hover:underline" href={`/projects/${p.id}`}>
                  {p.number}
                </Link>
                <span className="text-muted-foreground max-w-56 truncate">{p.name}</span>
                <StatusBadge entity="project" status={p.status} />
                <Progress value={p.completionPct} className="ml-auto" />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );

  const timelineTab = (
    <Panel>
      <div className="mb-4">
        <FilterBar
          filters={[
            {
              param: 'kinds',
              label: 'Events',
              multi: true,
              options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
            },
            {
              param: 'record',
              label: 'Records',
              options: targets.map((t) => ({
                value: `${t.entityType}:${t.entityId}`,
                label:
                  t.entityType === 'CLIENT'
                    ? 'Client only'
                    : `${ENTITY_TYPE_LABELS[t.entityType]} ${t.label}`,
              })),
            },
          ]}
        />
      </div>
      <Timeline
        query={query}
        initial={timeline}
        me={{ id: ctx.user.id, isAdmin }}
        contacts={contacts}
        today={today}
      />
    </Panel>
  );

  const documentsTab = (
    <Panel bodyClassName="p-0">
      {documents.items.length === 0 ? (
        <EmptyState message="No documents yet. Upload them on the client’s quotations." />
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
              <Link
                className="text-muted-foreground text-[13px] hover:underline"
                href={`/quotations/${d.entityId}?tab=documents`}
              >
                {d.entityLabel}
              </Link>
              <span className="text-muted-foreground num text-[13px]">
                {formatBytes(d.sizeBytes)}
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
        breadcrumbs={[{ label: 'Clients', href: '/clients' }, { label: client.name }]}
        title={client.name}
        description={client.sector.name}
        badge={deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
        actions={
          <>
            {!deleted && (
              <FollowUpSheet
                mode="create"
                triggerLabel="Log follow-up"
                triggerVariant="outline"
                targets={targets}
                contacts={contacts}
                today={today}
              />
            )}
            {isAdmin && (
              <Button asChild variant="outline">
                <Link href={`/admin/clients/${client.id}`}>Edit client</Link>
              </Button>
            )}
          </>
        }
      />
      <DetailLayout
        main={
          <RecordTabs
            defaultTab={timelineFiltered ? 'timeline' : 'overview'}
            tabs={[
              { id: 'overview', label: 'Overview', content: overview },
              { id: 'pipeline', label: 'Pipeline', content: pipeline },
              { id: 'timeline', label: 'Timeline', content: timelineTab },
              { id: 'documents', label: 'Documents', content: documentsTab },
            ]}
          />
        }
        side={
          <Panel title="Key facts">
            <FieldGrid
              columns={1}
              items={[
                {
                  label: 'Primary contact',
                  value: primary
                    ? [primary.name, primary.phone, primary.email].filter(Boolean).join(' · ')
                    : '—',
                },
                { label: 'Enquiries', value: <span className="num">{enquiries.total}</span> },
                { label: 'Quotations', value: <span className="num">{quotations.total}</span> },
                { label: 'Projects', value: <span className="num">{projects.total}</span> },
                { label: 'Documents', value: <span className="num">{documents.total}</span> },
              ]}
            />
          </Panel>
        }
      />
    </>
  );
}
