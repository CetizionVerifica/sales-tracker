import {
  can,
  getClient,
  getClientTimeline,
  listEnquiries,
  listFollowUpTargets,
  NotFoundError,
} from '@sales-tracker/core';
import {
  clientTimelineSchema,
  todayInIST,
  toCalendarDateString,
} from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ListToolbar } from '@/components/data-table/ListToolbar';
import { FollowUpDialog } from '@/components/timeline/FollowUpDialog';
import { Timeline, type TimelineQuery } from '@/components/timeline/Timeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { STATUS_BADGE, STATUS_LABELS } from '@/lib/enquiry-labels';
import { ENTITY_TYPE_LABELS, KIND_LABELS } from '@/lib/follow-up-labels';
import { formatDate } from '@/lib/format';
import type { SearchParams } from '@/lib/list-params';

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

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

  const query = timelineQuery(client.id, await searchParams);
  const [timeline, targets, enquiries] = await Promise.all([
    getClientTimeline(ctx, query).catch((error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    }),
    deleted ? [] : listFollowUpTargets(ctx, client.id),
    listEnquiries(ctx, { clientId: client.id, pageSize: 10 }),
  ]);
  const primary = client.contacts.find((c) => c.isPrimary);
  const contacts = client.contacts.map((c) => ({ id: c.id, name: c.name }));
  const today = toCalendarDateString(todayInIST());

  return (
    <section className="flex flex-col gap-8 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{client.name}</h1>
          {deleted && <Badge variant="destructive">Deleted</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!deleted && (
            <FollowUpDialog
              mode="create"
              triggerLabel="Log follow-up"
              targets={targets}
              contacts={contacts}
              today={today}
            />
          )}
          {isAdmin && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/admin/clients/${client.id}`}>Edit client</Link>
            </Button>
          )}
        </div>
      </div>

      <dl className="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
        <Item label="Sector">{client.sector.name}</Item>
        <Item label="GSTIN">{client.gstin ?? '—'}</Item>
        <Item label="Primary contact">
          {primary ? [primary.name, primary.phone, primary.email].filter(Boolean).join(' · ') : '—'}
        </Item>
      </dl>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        <section className="flex flex-col gap-4 lg:col-span-2">
          <h2 className="text-lg font-semibold">Timeline</h2>
          <ListToolbar
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
          <Timeline
            query={query}
            initial={timeline}
            me={{ id: ctx.user.id, isAdmin }}
            contacts={contacts}
            today={today}
          />
        </section>

        <aside className="flex flex-col gap-8">
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Enquiries</h2>
            {enquiries.items.length === 0 ? (
              <p className="text-muted-foreground text-sm">None you can see.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {enquiries.items.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2">
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      href={`/enquiries/${e.id}`}
                    >
                      {e.number}
                    </Link>
                    <Badge variant={STATUS_BADGE[e.status]}>{STATUS_LABELS[e.status]}</Badge>
                    <span className="text-muted-foreground">{formatDate(e.receivedDate)}</span>
                  </li>
                ))}
              </ul>
            )}
            {enquiries.total > enquiries.items.length && (
              <Link
                className="text-sm underline-offset-4 hover:underline"
                href={`/enquiries?clientId=${client.id}`}
              >
                All {enquiries.total} enquiries
              </Link>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Contacts</h2>
            {client.contacts.length === 0 ? (
              <p className="text-muted-foreground text-sm">No contacts.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {client.contacts.map((c) => (
                  <li key={c.id}>
                    <span className="font-medium">{c.name}</span>
                    {c.isPrimary && (
                      <Badge variant="secondary" className="ml-2">
                        Primary
                      </Badge>
                    )}
                    <div className="text-muted-foreground">
                      {[c.designation, c.phone, c.email].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
