'use client';

import type { TimelineEvent } from '@sales-tracker/core';
import type {
  EnquiryStatusValue,
  FollowUpChannelValue,
  FollowUpEntityTypeValue,
  TimelineKind,
} from '@sales-tracker/core/schemas';
import {
  ArrowRightLeft,
  FilePlus,
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
import { ConfirmButton } from '@/components/ConfirmButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { applyResult } from '@/lib/apply-result';
import { STATUS_LABELS } from '@/lib/enquiry-labels';
import { CHANNEL_LABELS, ENTITY_TYPE_LABELS, recordHref } from '@/lib/follow-up-labels';
import { formatDate, formatTime } from '@/lib/format';
import { deleteFollowUpAction, loadTimelineAction } from './actions';
import { FollowUpDialog } from './FollowUpDialog';

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
};

const KIND_VERBS: Partial<Record<TimelineKind, string>> = {
  CREATED: 'created',
  DELETED: 'deleted',
  RESTORED: 'restored',
};

function statusLabel(type: FollowUpEntityTypeValue, status: string): string {
  return type === 'ENQUIRY'
    ? (STATUS_LABELS[status as EnquiryStatusValue] ?? status)
    : status.toLowerCase();
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
        <Badge variant="outline" className="ml-1">
          deleted
        </Badge>
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
    <li className="flex gap-3" data-kind={event.kind}>
      <span className="bg-muted mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm">
          <span className="font-medium">{event.actor.name}</span>{' '}
          {followUp ? (
            <>
              logged {CHANNEL_LABELS[followUp.channel].toLowerCase()}
              {followUp.contact && <> with {followUp.contact.name}</>}
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
          <span className="text-muted-foreground"> · {formatTime(event.at)}</span>
        </p>
        {event.change?.lostReason && (
          <p className="text-muted-foreground text-sm">Reason: {event.change.lostReason}</p>
        )}
        {followUp && (
          <>
            <p className="text-sm whitespace-pre-line">{followUp.notes}</p>
            {followUp.nextFollowUpDate && (
              <p className="text-muted-foreground text-sm">
                Next follow-up: {formatDate(followUp.nextFollowUpDate)}
              </p>
            )}
            {canEdit && (
              <div className="flex gap-2">
                <FollowUpDialog
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
                <ConfirmButton
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
    return <p className="text-muted-foreground text-sm">Nothing here yet.</p>;
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
          <li key={day} className="flex flex-col gap-3">
            <h3 className="text-muted-foreground text-sm font-medium">{formatDate(day)}</h3>
            <ul className="flex flex-col gap-4">
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
