'use client';

import type { TimelineEvent } from '@sales-tracker/core';
import type {
  EnquiryStatusValue,
  FollowUpChannelValue,
  FollowUpEntityTypeValue,
  QuotationStatusValue,
  TimelineKind,
} from '@sales-tracker/core/schemas';
import {
  ArrowRightLeft,
  FilePlus,
  FileText,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquare,
  Phone,
  RotateCcw,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge } from '@/components/pipeline/StatusBadge';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { applyResult } from '@/lib/apply-result';
import { fieldLabel } from '@/lib/document-labels';
import { STATUS_LABELS } from '@/lib/enquiry-labels';
import { QUOTATION_STATUS_LABELS } from '@/lib/quotation-labels';
import { CHANNEL_LABELS, ENTITY_TYPE_LABELS, recordHref } from '@/lib/follow-up-labels';
import { formatDate, formatTime } from '@/lib/format';
import { deleteFollowUpAction, loadTimelineAction } from './actions';
import { FollowUpSheet } from './FollowUpSheet';

const CHANNEL_ICONS: Record<FollowUpChannelValue, LucideIcon> = {
  CALL: Phone,
  EMAIL: Mail,
  MEETING: Users,
  SITE_VISIT: MapPin,
  WHATSAPP: MessageCircle,
  OTHER: MessageSquare,
};

const KIND_ICONS: Partial<Record<TimelineKind, LucideIcon>> = {
  CREATED: FilePlus,
  STATUS_CHANGE: ArrowRightLeft,
  DELETED: Trash2,
  RESTORED: RotateCcw,
  DOCUMENT: FileText,
};

const DOCUMENT_VERBS = {
  UPLOADED: 'uploaded',
  CONFIRMED: 'confirmed',
  DELETED: 'deleted',
  REPLACED: 'replaced',
  RESTORED: 'restored',
} as const;

const STAGE_DOT: Partial<Record<FollowUpEntityTypeValue, string>> = {
  ENQUIRY: 'bg-stage-enquiry',
  QUOTATION: 'bg-stage-quotation',
  PROJECT: 'bg-stage-project',
  PURCHASE_ORDER: 'bg-stage-po',
  INVOICE: 'bg-stage-invoice',
};

/** Follow-up = primary, record events = the record's stage colour, documents = neutral. */
function dotClass(event: TimelineEvent): string {
  if (event.kind === 'FOLLOW_UP') return 'bg-primary';
  if (event.kind === 'DOCUMENT' || event.kind === 'DELETED' || event.kind === 'RESTORED') {
    return 'bg-neutral';
  }
  return STAGE_DOT[event.entity.type] ?? 'bg-neutral';
}

const KIND_VERBS: Partial<Record<TimelineKind, string>> = {
  CREATED: 'created',
  DELETED: 'deleted',
  RESTORED: 'restored',
};

function statusLabel(type: FollowUpEntityTypeValue, status: string): string {
  if (type === 'ENQUIRY') return STATUS_LABELS[status as EnquiryStatusValue] ?? status;
  if (type === 'QUOTATION') {
    return QUOTATION_STATUS_LABELS[status as QuotationStatusValue] ?? status;
  }
  return status.toLowerCase();
}

export interface TimelineQuery {
  clientId: string;
  entityType?: FollowUpEntityTypeValue;
  entityId?: string;
  kinds?: TimelineKind[];
}

function RecordLabel({ entity }: { entity: TimelineEvent['entity'] }) {
  const text =
    entity.type === 'CLIENT' ? 'the client' : `${ENTITY_TYPE_LABELS[entity.type]} ${entity.label}`;
  const href = entity.deleted ? null : recordHref(entity.type, entity.id);
  return (
    <>
      {href ? (
        <Link className="underline-offset-4 hover:underline" href={href}>
          {text}
        </Link>
      ) : (
        <span>{text}</span>
      )}
      {entity.deleted && entity.type !== 'CLIENT' && (
        <span className="ml-1">
          <MarkBadge tone="destructive">Deleted</MarkBadge>
        </span>
      )}
    </>
  );
}

function EventItem({
  event,
  showRecord,
  canEdit,
  contacts,
  today,
}: {
  event: TimelineEvent;
  showRecord: boolean;
  canEdit: boolean;
  contacts: { id: string; name: string }[];
  today: string;
}) {
  const followUp = event.followUp;
  const Icon = followUp ? CHANNEL_ICONS[followUp.channel] : (KIND_ICONS[event.kind] ?? FilePlus);

  return (
    <li className="relative flex gap-3 pl-5" data-kind={event.kind}>
      {/* 8px dot on the line, coloured by event type (UI guide §5 Timeline). */}
      <span
        className={cn(
          'absolute top-1.5 -left-1 size-2 rounded-full ring-2 ring-card',
          dotClass(event),
        )}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p>
          <Icon
            className="text-muted-foreground mr-1.5 inline size-4 align-[-3px]"
            strokeWidth={1.75}
            aria-hidden
          />
          <span className="font-medium">{event.actor.name}</span>{' '}
          {followUp ? (
            <>
              logged {CHANNEL_LABELS[followUp.channel].toLowerCase()}
              {followUp.contact && <> with {followUp.contact.name}</>}
            </>
          ) : event.document ? (
            <>
              {DOCUMENT_VERBS[event.document.action]} {event.document.filename}
              {' on'}
            </>
          ) : event.change ? (
            <>
              changed status from {statusLabel(event.entity.type, event.change.from)} to{' '}
              {statusLabel(event.entity.type, event.change.to)}
            </>
          ) : (
            KIND_VERBS[event.kind]
          )}
          {(showRecord || !followUp) && (
            <>
              {followUp ? ' on ' : ' '}
              <RecordLabel entity={event.entity} />
            </>
          )}
          <span className="text-muted-foreground num"> · {formatTime(event.at)}</span>
        </p>
        {event.document?.appliedFields && (
          <p className="text-muted-foreground text-[13px]">
            {event.document.appliedFields.length > 0
              ? `Applied ${event.document.appliedFields.map(fieldLabel).join(', ')}`
              : 'Confirmed without changes'}
          </p>
        )}
        {event.change?.lostReason && (
          <p className="text-muted-foreground text-[13px]">Reason: {event.change.lostReason}</p>
        )}
        {event.change?.poReceivedDate && (
          <p className="text-muted-foreground text-[13px]">
            PO received on {formatDate(event.change.poReceivedDate)}
          </p>
        )}
        {followUp && (
          <>
            <p className="whitespace-pre-line">{followUp.notes}</p>
            {followUp.nextFollowUpDate && (
              <p className="text-muted-foreground text-[13px]">
                Next follow-up: {formatDate(followUp.nextFollowUpDate)}
              </p>
            )}
            {canEdit && (
              <div className="flex gap-2">
                <FollowUpSheet
                  mode="edit"
                  triggerLabel="Edit"
                  triggerVariant="ghost"
                  contacts={contacts}
                  today={today}
                  initial={{
                    id: event.id,
                    entityType: event.entity.type,
                    entityId: event.entity.id,
                    date: new Date(followUp.date).toISOString().slice(0, 10),
                    channel: followUp.channel,
                    contactId: followUp.contact?.id ?? '',
                    notes: followUp.notes,
                    nextFollowUpDate: followUp.nextFollowUpDate
                      ? new Date(followUp.nextFollowUpDate).toISOString().slice(0, 10)
                      : '',
                  }}
                />
                <ConfirmDialog
                  label="Delete"
                  variant="ghost"
                  title="Delete this follow-up?"
                  description="It disappears from the timeline."
                  success="Follow-up deleted"
                  run={() => deleteFollowUpAction({ id: event.id })}
                />
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Events grouped by day (IST), newest first. The first page is rendered by the server;
 * "Load more" follows the cursor. A refresh (after logging or editing) replaces the first
 * page and drops pages loaded since, so nothing stale stays on screen.
 */
export function Timeline({
  query,
  initial,
  me,
  contacts,
  today,
  showRecord = true,
}: {
  query: TimelineQuery;
  initial: { items: TimelineEvent[]; nextCursor: string | null };
  me: { id: string; isAdmin: boolean };
  contacts: { id: string; name: string }[];
  today: string;
  showRecord?: boolean;
}) {
  const [more, setMore] = useState<TimelineEvent[]>([]);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, startTransition] = useTransition();
  // A refresh brings a new first page: drop the pages loaded after the old one.
  const [page, setPage] = useState(initial);
  if (page !== initial) {
    setPage(initial);
    setMore([]);
    setCursor(initial.nextCursor);
  }

  const events = [...initial.items, ...more];
  if (events.length === 0) {
    return (
      <EmptyState
        message="Nothing here yet. Log a follow-up to start the timeline."
        className="py-6"
      />
    );
  }

  const days: { day: string; events: TimelineEvent[] }[] = [];
  for (const event of events) {
    const last = days.at(-1);
    if (last?.day === event.day) last.events.push(event);
    else days.push({ day: event.day, events: [event] });
  }

  function loadMore() {
    if (!cursor) return;
    startTransition(async () => {
      const result = await loadTimelineAction({ ...query, cursor });
      if (applyResult(result)) {
        setMore((current) => [...current, ...result.data.items]);
        setCursor(result.data.nextCursor);
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <ol aria-label="Timeline" className="flex flex-col gap-6">
        {days.map(({ day, events: dayEvents }) => (
          <li
            key={day}
            className="grid grid-cols-1 gap-2 md:grid-cols-[112px_minmax(0,1fr)] md:gap-4"
          >
            <h3 className="text-muted-foreground num text-[13px] font-medium md:pt-0.5">
              {formatDate(day)}
            </h3>
            <ul className="border-border ml-1 flex flex-col gap-4 border-l">
              {dayEvents.map((event) => (
                <EventItem
                  key={`${event.kind}:${event.id}`}
                  event={event}
                  showRecord={showRecord}
                  canEdit={
                    event.kind === 'FOLLOW_UP' && (me.isAdmin || event.followUp?.userId === me.id)
                  }
                  contacts={contacts}
                  today={today}
                />
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {cursor && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={pending}
          onClick={loadMore}
        >
          {pending ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
