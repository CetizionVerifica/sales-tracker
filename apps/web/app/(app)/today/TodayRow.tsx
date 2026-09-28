'use client';

import type { MyTodayKind } from '@sales-tracker/core/schemas';
import {
  Briefcase,
  FileSearch,
  FileText,
  Inbox,
  PhoneCall,
  Receipt,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { DateDisplay } from '@/components/display/DateDisplay';
import { Money } from '@/components/display/Money';
import { RelativeDue } from '@/components/display/RelativeDue';
import { MarkPaidDialog } from '@/components/invoices/PaymentDialogs';
import { FollowUpSheet } from '@/components/timeline/FollowUpSheet';
import { Button } from '@/components/ui/button';
import { MY_TODAY_KIND_LABELS } from '@/lib/my-today-labels';
import type { TodayRowView } from './today-view';

const ICONS: Record<MyTodayKind, LucideIcon> = {
  INVOICE_OVERDUE: Receipt,
  INVOICE_DUE: Receipt,
  QUOTATION_AWAITING_REPLY: FileText,
  FOLLOW_UP_DUE: PhoneCall,
  PROJECT_BEHIND_SCHEDULE: Briefcase,
  STALE_ENQUIRY: Inbox,
  DOCUMENT_TO_REVIEW: FileSearch,
};

/**
 * One My Today row (UI guide 4.4): icon, "Client — what to do", the record, the due date,
 * then the actions the viewer may take. Actions wrap under the text on narrow screens.
 */
export function TodayRow({
  row,
  today,
  contacts,
}: {
  row: TodayRowView;
  today: string;
  contacts: { id: string; name: string }[];
}) {
  const Icon = ICONS[row.kind];
  return (
    // One line from 1280px; below that (768px, or 1024px beside the sidebar) the actions
    // wrap under the text, which keeps its width. Side by side, three buttons left the
    // text a few words wide, or were clipped.
    <div className="flex flex-col gap-3 px-4 py-3 xl:flex-row xl:items-center xl:gap-4">
      <div className="flex min-w-0 flex-1 gap-3 xl:min-w-[280px]">
        <Icon
          className="text-muted-foreground mt-0.5 size-[18px] shrink-0"
          strokeWidth={1.75}
          aria-label={MY_TODAY_KIND_LABELS[row.kind]}
          role="img"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm">
            <Link href={row.client.href} className="font-medium hover:underline">
              {row.client.name}
            </Link>
            <span className="text-muted-foreground"> — </span>
            {row.title}
          </p>
          <p className="text-muted-foreground flex flex-wrap gap-x-2 text-[13px]">
            <Link href={row.record.href} className="text-foreground hover:underline">
              {row.record.label}
            </Link>
            {row.detail && <span className="min-w-0 break-words">{row.detail}</span>}
            {row.alsoReasons.map((reason) => (
              <span key={reason.kind}>
                · {MY_TODAY_KIND_LABELS[reason.kind]} <DateDisplay value={reason.dueDate} />
              </span>
            ))}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-[30px] xl:justify-end xl:pl-0">
        {row.amount && (
          <Money amountMinor={row.amount.amountMinor} currency={row.amount.currency} />
        )}
        <RelativeDue date={row.dueDate} today={today} className="text-sm" />
        <div className="flex flex-wrap items-center gap-2">
          {row.actions.includes('MARK_PAID') && row.invoice && (
            <MarkPaidDialog
              id={row.invoice.id}
              label={row.invoice.label.replace(/^Invoice/, 'invoice')}
              invoiceDate={row.invoice.invoiceDate}
              today={today}
              variant="outline"
            />
          )}
          {row.actions.includes('LOG_FOLLOW_UP') && row.followUp && (
            <FollowUpSheet
              mode="create"
              triggerLabel="Log follow-up"
              triggerVariant="outline"
              targets={[row.followUp]}
              contacts={contacts}
              today={today}
              nextRequired={row.followUp.entityType === 'QUOTATION'}
            />
          )}
          {row.actions.includes('REVIEW') && (
            <Button asChild size="sm" variant="outline">
              <Link href={row.record.href}>Review</Link>
            </Button>
          )}
          {row.actions.includes('OPEN') && (
            <Button asChild size="sm" variant="ghost">
              <Link href={row.openHref} aria-label={`Open ${row.record.label}`}>
                Open
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
