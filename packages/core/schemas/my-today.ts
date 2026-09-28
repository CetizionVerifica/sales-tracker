import { z } from 'zod';
import type { FollowUpEntityTypeValue } from './follow-up.ts';

/**
 * M11 row kinds, in priority order: when a record qualifies for several, its row takes the
 * first (Decision 4: money first, then client-facing promises, then internal hygiene).
 * Documents are keyed by the document, so they never merge with their record's row.
 */
export const MY_TODAY_KINDS = [
  'INVOICE_OVERDUE',
  'INVOICE_DUE',
  'QUOTATION_AWAITING_REPLY',
  'FOLLOW_UP_DUE',
  'PROJECT_BEHIND_SCHEDULE',
  'STALE_ENQUIRY',
  'DOCUMENT_TO_REVIEW',
] as const;

export const myTodayKindSchema = z.enum(MY_TODAY_KINDS);
export type MyTodayKind = (typeof MY_TODAY_KINDS)[number];

/** The kind chips on the page: several kinds share a chip (both invoice kinds). */
export const MY_TODAY_KIND_GROUPS = {
  followUps: ['FOLLOW_UP_DUE'],
  quotations: ['QUOTATION_AWAITING_REPLY'],
  invoices: ['INVOICE_OVERDUE', 'INVOICE_DUE'],
  projects: ['PROJECT_BEHIND_SCHEDULE'],
  enquiries: ['STALE_ENQUIRY'],
  documents: ['DOCUMENT_TO_REVIEW'],
} as const satisfies Record<string, readonly MyTodayKind[]>;

export type MyTodayKindGroup = keyof typeof MY_TODAY_KIND_GROUPS;

export const myTodayKindGroupSchema = z.enum(
  Object.keys(MY_TODAY_KIND_GROUPS) as [MyTodayKindGroup, ...MyTodayKindGroup[]],
);

/**
 * `userId` omitted: the actor's own list. Another user's: admins only (Decision 6).
 * `kind` narrows the rows to one chip's kinds before sections are capped and counted.
 */
export const myTodaySchema = z
  .object({
    userId: z.string().trim().min(1).optional(),
    kind: myTodayKindGroupSchema.optional(),
  })
  .strict();

export type MyTodayInput = z.input<typeof myTodaySchema>;

/** Rows per section; counts stay exact (Decision 7). */
export const MY_TODAY_SECTION_LIMIT = 100;

/** Coming up = today + 1 to today + this many days (Decision 10, M10's `next7`). */
export const MY_TODAY_HORIZON_DAYS = 7;

export type MyTodayAction = 'LOG_FOLLOW_UP' | 'MARK_PAID' | 'REVIEW' | 'OPEN';

export type MyTodayRecordType = FollowUpEntityTypeValue | 'DOCUMENT';

export interface MyTodayRow {
  /** `<record type>:<id>`: one row per record (Decision 4). */
  key: string;
  kind: MyTodayKind;
  /** IST calendar day (UTC midnight); decides the section (Decision 3). */
  dueDate: Date;
  /** Negative when overdue. */
  daysFromToday: number;
  record: { type: MyTodayRecordType; id: string; label: string };
  client: { id: string; name: string };
  title: string;
  detail: string | null;
  /** The other kinds this record qualified for, merged into this row. */
  alsoReasons: { kind: MyTodayKind; dueDate: Date }[];
  /** Invoice rows. */
  amount: { amountMinor: bigint; currency: string } | null;
  /** For MARK_PAID: the invoice's date, the earliest allowed paid date. */
  invoiceDate: Date | null;
  /** What the viewer may do from the row (Decision 6: Open only on someone else's list). */
  actions: MyTodayAction[];
  /** For LOG_FOLLOW_UP: the record the follow-up is logged on (a document's parent). */
  followUpTarget: { entityType: FollowUpEntityTypeValue; entityId: string } | null;
}

export interface MyTodaySections {
  overdue: MyTodayRow[];
  dueToday: MyTodayRow[];
  comingUp: MyTodayRow[];
}

export interface MyTodayCounts {
  /** Section counts, after the `kind` filter. */
  overdue: number;
  dueToday: number;
  comingUp: number;
  /** Every kind, before the `kind` filter (the chips' counts). */
  byKind: Record<MyTodayKind, number>;
  /** Overdue + due today, before the `kind` filter: the nav badge. */
  badge: number;
}

export interface MyToday {
  today: Date;
  user: { id: string; name: string };
  /** The viewer is looking at someone else's list (admins). */
  viewingOther: boolean;
  /** The chip the rows are narrowed to, if any. */
  kind: MyTodayKindGroup | null;
  sections: MyTodaySections;
  counts: MyTodayCounts;
}
