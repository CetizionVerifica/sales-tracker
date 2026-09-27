import { can, enquiryResource } from '@sales-tracker/core';
import { todayInIST, toCalendarDateString } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { SOURCE_DETAIL, SOURCE_LABELS, STATUS_BADGE, STATUS_LABELS } from '@/lib/enquiry-labels';
import { formatDate, formatDateTime } from '@/lib/format';
import { deleteEnquiryAction, restoreEnquiryAction } from '../actions';
import { loadEnquiryOr404 } from '../load';
import { EnquiryHistory } from './EnquiryHistory';
import { ConvertDialog, MarkLostDialog } from './StatusActions';

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default async function EnquiryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const enquiry = await loadEnquiryOr404(ctx, (await params).id);
  const resource = enquiryResource(enquiry);
  const deleted = enquiry.deletedAt !== null;
  const canUpdate = !deleted && can(ctx.user, 'update', resource);
  const canDelete = can(ctx.user, 'delete', resource);
  const inProgress = enquiry.status === 'IN_PROGRESS';

  return (
    <section className="flex flex-col gap-8 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{enquiry.number}</h1>
          <Badge variant={STATUS_BADGE[enquiry.status]}>{STATUS_LABELS[enquiry.status]}</Badge>
          {deleted && <Badge variant="destructive">Deleted</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          {canUpdate && inProgress && (
            <>
              <ConvertDialog
                id={enquiry.id}
                receivedDate={toCalendarDateString(enquiry.receivedDate)}
                proposalSentDate={
                  enquiry.proposalSentDate ? toCalendarDateString(enquiry.proposalSentDate) : ''
                }
                today={toCalendarDateString(todayInIST())}
              />
              <MarkLostDialog id={enquiry.id} />
            </>
          )}
          {!deleted && enquiry.status === 'CONVERTED' && (
            <Button asChild size="sm">
              <Link href={`/quotations/new?enquiryId=${enquiry.id}`}>Create quotation</Link>
            </Button>
          )}
          {canUpdate && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/enquiries/${enquiry.id}/edit`}>Edit</Link>
            </Button>
          )}
          {canDelete && !deleted && enquiry.status !== 'CONVERTED' && (
            <ConfirmButton
              label="Delete"
              variant="destructive"
              title={`Delete ${enquiry.number}?`}
              description="It disappears from the list. You can restore it from the Deleted filter."
              success="Enquiry deleted"
              run={async () => {
                'use server';
                return deleteEnquiryAction({ id: enquiry.id });
              }}
            />
          )}
          {canDelete && deleted && (
            <ConfirmButton
              label="Restore"
              title={`Restore ${enquiry.number}?`}
              description="The enquiry comes back into the list."
              success="Enquiry restored"
              run={async () => {
                'use server';
                return restoreEnquiryAction({ id: enquiry.id });
              }}
            />
          )}
        </div>
      </div>

      <dl className="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
        <Item label="Client">{enquiry.client.name}</Item>
        <Item label="Sector">{enquiry.sector.name}</Item>
        <Item label="Services">{enquiry.services.map((s) => s.name).join(', ')}</Item>
        <Item label="Owner">{enquiry.owner.name}</Item>
        <Item label="Received on">{formatDate(enquiry.receivedDate)}</Item>
        <Item label="Proposal sent on">{formatDate(enquiry.proposalSentDate)}</Item>
        <Item label="Source">{SOURCE_LABELS[enquiry.source]}</Item>
        {enquiry.sourceDetail && (
          <Item label={SOURCE_DETAIL[enquiry.source].label}>{enquiry.sourceDetail}</Item>
        )}
        {enquiry.description && (
          <div className="sm:col-span-2">
            <Item label="What they asked for">
              <p className="whitespace-pre-line">{enquiry.description}</p>
            </Item>
          </div>
        )}
        {enquiry.lostReason && <Item label="Lost because">{enquiry.lostReason}</Item>}
        {enquiry.statusChangedAt && (
          <Item label="Status changed">{formatDateTime(enquiry.statusChangedAt)}</Item>
        )}
        <Item label="Created">{formatDateTime(enquiry.createdAt)}</Item>
        <Item label="Updated">{formatDateTime(enquiry.updatedAt)}</Item>
      </dl>

      <EnquiryHistory ctx={ctx} enquiryId={enquiry.id} />
    </section>
  );
}
