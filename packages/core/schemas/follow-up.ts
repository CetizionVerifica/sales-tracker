import { z } from 'zod';
import { calendarDateSchema, clearable, idOnlySchema, todayInIST, withId } from './common.ts';
import { listParamsSchema, multi, recordStatusSchema } from './list-params.ts';

export const FOLLOW_UP_CHANNELS = [
  'CALL',
  'EMAIL',
  'MEETING',
  'SITE_VISIT',
  'WHATSAPP',
  'OTHER',
] as const;

/** Every record type a follow-up can link to; the service accepts only shipped ones. */
export const FOLLOW_UP_ENTITY_TYPES = [
  'CLIENT',
  'ENQUIRY',
  'QUOTATION',
  'PROJECT',
  'PURCHASE_ORDER',
  'INVOICE',
] as const;

/** Timeline event kinds. DOCUMENT is reserved for M7. */
export const TIMELINE_KINDS = [
  'FOLLOW_UP',
  'CREATED',
  'STATUS_CHANGE',
  'DELETED',
  'RESTORED',
  'DOCUMENT',
] as const;

export type FollowUpChannelValue = (typeof FOLLOW_UP_CHANNELS)[number];
export type FollowUpEntityTypeValue = (typeof FOLLOW_UP_ENTITY_TYPES)[number];
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const NEXT_BEFORE_DATE = 'The next follow-up cannot be before this one';

const pastDate = calendarDateSchema.refine(
  (date) => date <= todayInIST(),
  'The date cannot be in the future',
);

const followUpFields = {
  date: pastDate,
  channel: z.enum(FOLLOW_UP_CHANNELS, 'Choose how you were in touch'),
  notes: z.string().trim().min(1, 'Add what was discussed').max(4000),
  contactId: clearable(z.string().min(1)),
  nextFollowUpDate: clearable(calendarDateSchema),
};

function nextAfterDate(
  input: { date?: Date | undefined; nextFollowUpDate?: Date | null | undefined },
  context: z.RefinementCtx,
) {
  if (input.date && input.nextFollowUpDate && input.nextFollowUpDate < input.date) {
    context.addIssue({ code: 'custom', path: ['nextFollowUpDate'], message: NEXT_BEFORE_DATE });
  }
}

/** No clientId or userId: the service derives them from the linked record and the actor. */
export const createFollowUpSchema = z
  .object({
    entityType: z.enum(FOLLOW_UP_ENTITY_TYPES, 'Choose what this follow-up is about'),
    entityId: z.string().min(1, 'Choose what this follow-up is about'),
    ...followUpFields,
  })
  .superRefine(nextAfterDate);

/**
 * The link (entityType, entityId) cannot change: unknown keys are stripped. The next-date
 * rule is checked here when both dates are given, and on the merged record in the service.
 */
export const updateFollowUpSchema = z.object(followUpFields).partial().superRefine(nextAfterDate);

export const FOLLOW_UP_SORTS = ['date', 'nextFollowUpDate', 'createdAt'] as const;

export const listFollowUpsSchema = listParamsSchema.extend({
  clientId: z.string().min(1).optional(),
  entityType: z.enum(FOLLOW_UP_ENTITY_TYPES).optional(),
  entityId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  channel: multi(FOLLOW_UP_CHANNELS),
  dateFrom: calendarDateSchema.optional(),
  dateTo: calendarDateSchema.optional(),
  nextFrom: calendarDateSchema.optional(),
  nextTo: calendarDateSchema.optional(),
  recordStatus: recordStatusSchema,
  sort: z.enum(FOLLOW_UP_SORTS).optional(),
});

// ─── Timeline ───────────────────────────────────────────────────────────────────────

/**
 * Keyset position of the last event on a page. Events sort by `day` desc, `at` desc, then
 * `rank` (source) and `id` asc, so the key is unique and total across sources.
 */
export const timelineCursorSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  at: z.iso.datetime(),
  rank: z.number().int().min(0),
  id: z.string().min(1),
});

export type TimelineCursor = z.output<typeof timelineCursorSchema>;

// btoa/atob rather than Buffer: schemas are also bundled for the browser. Cursor values
// are ASCII (ISO dates and uuids), so btoa is safe; the output is made URL-safe.
export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeTimelineCursor(value: string): TimelineCursor | null {
  try {
    const parsed = timelineCursorSchema.safeParse(
      JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const clientTimelineSchema = z
  .object({
    clientId: z.string().min(1),
    entityType: z.enum(FOLLOW_UP_ENTITY_TYPES).optional(),
    entityId: z.string().min(1).optional(),
    kinds: multi(TIMELINE_KINDS),
    // An opaque string from a previous page, or (when a server action has already parsed
    // the input once) the decoded cursor, so the service's parse is idempotent.
    cursor: z
      .union([
        timelineCursorSchema,
        z.string().transform((value, context) => {
          const cursor = value ? decodeTimelineCursor(value) : undefined;
          if (cursor === null) {
            context.addIssue({ code: 'custom', message: 'Invalid cursor' });
            return z.NEVER;
          }
          return cursor;
        }),
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .superRefine((input, context) => {
    if ((input.entityType === undefined) !== (input.entityId === undefined)) {
      context.addIssue({
        code: 'custom',
        path: [input.entityType ? 'entityId' : 'entityType'],
        message: 'Give both the record type and id',
      });
    }
  });

export type CreateFollowUpInput = z.input<typeof createFollowUpSchema>;
export type UpdateFollowUpInput = z.input<typeof updateFollowUpSchema>;
export type ListFollowUpsInput = z.input<typeof listFollowUpsSchema>;
export type ClientTimelineInput = z.input<typeof clientTimelineSchema>;

// Server-action transport shapes.
export const updateFollowUpActionSchema = withId(updateFollowUpSchema);
export const followUpIdActionSchema = idOnlySchema;
