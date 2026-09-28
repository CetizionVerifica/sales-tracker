import {
  toCalendarDateString,
  type FollowUpEntityTypeValue,
  type MyTodayAction,
  type MyTodayKind,
  type MyTodayRow,
} from '@sales-tracker/core/schemas';
import { recordHref } from '@/lib/follow-up-labels';

/** A My Today row as a client component can receive it: days as strings, money as a string. */
export interface TodayRowView {
  key: string;
  kind: MyTodayKind;
  dueDate: string;
  /** The record's page; for a document, its review screen. */
  record: { label: string; href: string };
  /** Where Open goes: the record, or a document's record. */
  openHref: string;
  client: { id: string; name: string; href: string };
  title: string;
  detail: string | null;
  alsoReasons: { kind: MyTodayKind; dueDate: string }[];
  amount: { amountMinor: string; currency: string } | null;
  actions: MyTodayAction[];
  /** For Log follow-up: the record it is logged on. */
  followUp: { entityType: FollowUpEntityTypeValue; entityId: string; label: string } | null;
  /** For Mark paid. */
  invoice: { id: string; label: string; invoiceDate: string } | null;
}

function pageOf(type: FollowUpEntityTypeValue, id: string, clientId: string): string {
  if (type === 'CLIENT') return `/clients/${id}`;
  return recordHref(type, id) ?? `/clients/${clientId}`;
}

function hrefFor(row: MyTodayRow): string {
  if (row.record.type === 'DOCUMENT') return `/documents/${row.record.id}/review`;
  return pageOf(row.record.type, row.record.id, row.client.id);
}

function openHrefFor(row: MyTodayRow): string {
  const target = row.followUpTarget;
  if (row.record.type === 'DOCUMENT' && target) {
    return pageOf(target.entityType, target.entityId, row.client.id);
  }
  return hrefFor(row);
}

export function toRowView(row: MyTodayRow): TodayRowView {
  const day = toCalendarDateString;
  return {
    key: row.key,
    kind: row.kind,
    dueDate: day(row.dueDate),
    record: { label: row.record.label, href: hrefFor(row) },
    openHref: openHrefFor(row),
    client: { ...row.client, href: `/clients/${row.client.id}` },
    title: row.title,
    detail: row.detail,
    alsoReasons: row.alsoReasons.map((r) => ({ kind: r.kind, dueDate: day(r.dueDate) })),
    amount: row.amount && {
      amountMinor: row.amount.amountMinor.toString(),
      currency: row.amount.currency,
    },
    actions: row.actions,
    followUp: row.followUpTarget && {
      ...row.followUpTarget,
      // A document's follow-up is logged on its record, whose label the row shows.
      label: row.record.label,
    },
    invoice:
      row.record.type === 'INVOICE' && row.invoiceDate
        ? { id: row.record.id, label: row.record.label, invoiceDate: day(row.invoiceDate) }
        : null,
  };
}
