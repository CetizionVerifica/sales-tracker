import {
  can,
  getClient,
  getClientTimeline,
  getLatestFollowUp,
  quotationResource,
} from '@sales-tracker/core';
import { formatMoney, todayInIST, toCalendarDateString } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { FollowUpDialog } from '@/components/timeline/FollowUpDialog';
import { Timeline } from '@/components/timeline/Timeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  isOpenQuotation,
  QUOTATION_STATUS_BADGE,
  QUOTATION_STATUS_LABELS,
} from '@/lib/quotation-labels';
import { deleteQuotationAction, restoreQuotationAction } from '../actions';
import { loadQuotationOr404 } from '../load';
import { StatusDialog } from './StatusActions';

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const quotation = await loadQuotationOr404(ctx, (await params).id);
  const resource = quotationResource(quotation);
  const deleted = quotation.deletedAt !== null;
  const canUpdate = !deleted && can(ctx.user, 'update', resource);
  const canDelete = can(ctx.user, 'delete', resource);
  const open = isOpenQuotation(quotation.status);
  const won = quotation.status === 'PO_RECEIVED';
  const today = toCalendarDateString(todayInIST());
  const quotationDate = toCalendarDateString(quotation.quotationDate);
  const next = quotation.nextFollowUpDate ? toCalendarDateString(quotation.nextFollowUpDate) : '';

  const query = {
    clientId: quotation.client.id,
    entityType: 'QUOTATION' as const,
    entityId: quotation.id,
  };
  const [timeline, latest, client] = await Promise.all([
    getClientTimeline(ctx, query),
    getLatestFollowUp(ctx, 'QUOTATION', quotation.id),
    getClient(ctx, quotation.client.id),
  ]);
  const contacts = client.contacts.map((c) => ({ id: c.id, name: c.name }));
  const canLog = !deleted && client.deletedAt === null;
  const synced = latest && latest.id === quotation.lastFollowUpId ? latest : null;
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

  return (
    <section className="flex flex-col gap-8 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{quotation.number}</h1>
          <Badge variant={QUOTATION_STATUS_BADGE[quotation.status]}>
            {QUOTATION_STATUS_LABELS[quotation.status]}
          </Badge>
          {deleted && <Badge variant="destructive">Deleted</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          {canLog && (
            <FollowUpDialog
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
          {canUpdate && quotation.status === 'SENT' && status('UNDER_NEGOTIATION')}
          {canUpdate && quotation.status === 'UNDER_NEGOTIATION' && status('SENT')}
          {canUpdate && open && status('PO_RECEIVED')}
          {canUpdate && open && status('LOST')}
          {canUpdate && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/quotations/${quotation.id}/edit`}>Edit</Link>
            </Button>
          )}
          {canDelete && !deleted && !won && (
            <ConfirmButton
              label="Delete"
              variant="destructive"
              title={`Delete ${quotation.number}?`}
              description="It disappears from the list. You can restore it from the Deleted filter."
              success="Quotation deleted"
              run={async () => {
                'use server';
                return deleteQuotationAction({ id: quotation.id });
              }}
            />
          )}
          {canDelete && deleted && (
            <ConfirmButton
              label="Restore"
              title={`Restore ${quotation.number}?`}
              description="The quotation comes back into the list."
              success="Quotation restored"
              run={async () => {
                'use server';
                return restoreQuotationAction({ id: quotation.id });
              }}
            />
          )}
        </div>
      </div>

      {won && !deleted && (
        <div
          role="status"
          className="flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-md border p-4"
        >
          <p>PO received on {formatDate(quotation.poReceivedDate)}. Set up the project next.</p>
          <Button asChild size="sm">
            <Link href={`/projects/new?quotationId=${quotation.id}`}>Create project</Link>
          </Button>
        </div>
      )}

      <dl className="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
        <Item label="Amount">
          <span className="text-lg font-medium">
            {formatMoney(quotation.amountMinor, quotation.currency)}
          </span>
        </Item>
        <Item label="Enquiry">
          <Link
            className="underline-offset-4 hover:underline"
            href={`/enquiries/${quotation.enquiry.id}`}
          >
            {quotation.enquiry.number}
          </Link>
        </Item>
        <Item label="Client">
          <Link
            className="underline-offset-4 hover:underline"
            href={`/clients/${quotation.client.id}`}
          >
            {quotation.client.name}
          </Link>
        </Item>
        <Item label="Sector">{quotation.sector.name}</Item>
        <Item label="Services">{quotation.services.map((s) => s.name).join(', ')}</Item>
        <Item label="Owner">{quotation.owner.name}</Item>
        <Item label="Quotation date">{formatDate(quotation.quotationDate)}</Item>
        {open && <Item label="Next follow-up">{formatDate(quotation.nextFollowUpDate)}</Item>}
        {quotation.poReceivedDate && (
          <Item label="PO received on">{formatDate(quotation.poReceivedDate)}</Item>
        )}
        {quotation.lostReason && <Item label="Lost because">{quotation.lostReason}</Item>}
        {quotation.lastFollowUpHighlights && (
          <div className="sm:col-span-2">
            <Item
              label={
                synced
                  ? `Follow-up highlights (from ${formatDate(synced.date)})`
                  : 'Follow-up highlights'
              }
            >
              <p className="whitespace-pre-line">{quotation.lastFollowUpHighlights}</p>
            </Item>
          </div>
        )}
        {quotation.description && (
          <div className="sm:col-span-2">
            <Item label="Scope and notes">
              <p className="whitespace-pre-line">{quotation.description}</p>
            </Item>
          </div>
        )}
        {quotation.statusChangedAt && (
          <Item label="Status changed">{formatDateTime(quotation.statusChangedAt)}</Item>
        )}
        <Item label="Created">{formatDateTime(quotation.createdAt)}</Item>
        <Item label="Updated">{formatDateTime(quotation.updatedAt)}</Item>
      </dl>

      <section className="flex max-w-3xl flex-col gap-4">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <Timeline
          query={query}
          initial={timeline}
          me={{ id: ctx.user.id, isAdmin: can(ctx.user, 'list', 'user') }}
          contacts={contacts}
          today={today}
          showRecord={false}
        />
      </section>
    </section>
  );
}
