import { z } from 'zod';
import {
  calendarDateSchema,
  clearable,
  idOnlySchema,
  optionalText,
  requiredDay,
  todayInIST,
  withId,
} from './common.ts';
import { flag, listParamsSchema, multi, recordStatusSchema } from './list-params.ts';
import { currencySchema, isIsoCurrency, parseAmount } from './money.ts';

export const PROJECT_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ProjectStatusValue = (typeof PROJECT_STATUSES)[number];

export const END_BEFORE_START = 'The planned end cannot be before the start date';

const serviceIdsSchema = z
  .array(z.string().min(1))
  .min(1, 'Choose at least one service')
  .max(10, 'Choose at most 10 services')
  .refine((ids) => new Set(ids).size === ids.length, 'Each service can be chosen once');

const completionPctSchema = z.coerce
  .number()
  .int('Enter a whole number')
  .min(0, 'Completion is between 0 and 100')
  .max(100, 'Completion is between 0 and 100');

const reason = (message: string) => z.string().trim().min(1, message).max(500);

const projectFields = {
  name: z.string().trim().min(1, 'Enter a project name').max(200),
  /** An active PROJECT_MANAGER (checked in the service); omitted or '' leaves it unassigned. */
  managerId: clearable(z.string().min(1)),
  serviceIds: serviceIdsSchema,
  /** A decimal string ("1,25,000.50"); becomes `revenueMinor` with `currency`. */
  revenue: z.string().trim().min(1, 'Enter the revenue'),
  currency: currencySchema,
  /** A planned start may be in the future while NOT_STARTED (checked in the service). */
  startDate: clearable(calendarDateSchema),
  /** The planned end. */
  endDate: clearable(calendarDateSchema),
  description: optionalText(2000),
};

type MoneyInput = { revenue?: string | undefined; currency?: string | undefined };

/** Reports revenue that doesn't parse in its currency on `revenue`. */
function revenueParses(input: MoneyInput, context: z.RefinementCtx) {
  if (input.revenue === undefined || !input.currency || !isIsoCurrency(input.currency)) return;
  const parsed = parseAmount(input.revenue, input.currency);
  if (!parsed.ok) context.addIssue({ code: 'custom', path: ['revenue'], message: parsed.message });
}

/** Replaces `revenue` with `revenueMinor` (M6 Decision 3); runs after `revenueParses`. */
function withMinorUnits<T extends MoneyInput>({ revenue, ...rest }: T) {
  if (revenue === undefined || rest.currency === undefined) return rest;
  const parsed = parseAmount(revenue, rest.currency);
  if (!parsed.ok) throw new Error('unreachable: revenueParses already rejected this revenue');
  return { ...rest, revenueMinor: parsed.value };
}

function endAfterStart(
  input: { startDate?: Date | null | undefined; endDate?: Date | null | undefined },
  context: z.RefinementCtx,
) {
  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    context.addIssue({ code: 'custom', path: ['endDate'], message: END_BEFORE_START });
  }
}

/*
 * Two schemas per input, as M6: the `…FormSchema` keeps `revenue` as typed (forms and server
 * actions), the service schema converts it to minor units.
 */

/**
 * Always starts NOT_STARTED at 0%. No `clientId` (the quotation's, M8 Decision 3), `status`,
 * `number`, `completionPct`, `completedDate`, `holdReason` or `cancelReason`: strict, so any
 * of them is an error.
 */
export const createProjectFormSchema = z
  .strictObject({ quotationId: z.string().min(1, 'Choose the quotation'), ...projectFields })
  .superRefine(endAfterStart)
  .superRefine(revenueParses);

export const createProjectSchema = createProjectFormSchema.transform(
  (input) => withMinorUnits(input) as Omit<typeof input, 'revenue'> & { revenueMinor: bigint },
);

/**
 * Every field optional; `''` clears optional ones, `undefined` leaves them (M3 convention).
 * Revenue and currency travel together (M6). Which fields a role may change, and rules that
 * need the stored record, are checked in the service (M8 Decision 6).
 */
export const updateProjectFormSchema = z
  .strictObject({
    ...projectFields,
    completionPct: completionPctSchema,
  })
  .partial()
  .superRefine((input, context) => {
    if (Object.keys(input).length === 0) {
      context.addIssue({ code: 'custom', message: 'Nothing to update' });
    }
    if (input.revenue !== undefined && input.currency === undefined) {
      context.addIssue({ code: 'custom', path: ['currency'], message: 'Choose the currency' });
    }
    if (input.currency !== undefined && input.revenue === undefined) {
      context.addIssue({ code: 'custom', path: ['revenue'], message: 'Enter the revenue' });
    }
    endAfterStart(input, context);
    revenueParses(input, context);
  });

export const updateProjectSchema = updateProjectFormSchema.transform(
  (input) => withMinorUnits(input) as Omit<typeof input, 'revenue'> & { revenueMinor?: bigint },
);

/** The project page's "Update progress" popover (an update with only this field). */
export const projectProgressFormSchema = z.strictObject({ completionPct: completionPctSchema });

/** The project page's "Reassign" dialog (admins; '' = unassigned). */
export const projectManagerFormSchema = z.strictObject({ managerId: projectFields.managerId });

/** Fields only admins change after creation (M8 Decision 6); the form hides them for PMs. */
export const ADMIN_ONLY_PROJECT_FIELDS = [
  'managerId',
  'serviceIds',
  'revenue',
  'currency',
] as const;

const pastDay = (message: string) =>
  requiredDay(message).refine((date) => date <= todayInIST(), 'The date cannot be in the future');

export const changeProjectStatusSchema = z.discriminatedUnion('to', [
  idOnlySchema.extend({
    to: z.literal('IN_PROGRESS'),
    startDate: calendarDateSchema.optional(),
  }),
  idOnlySchema.extend({
    to: z.literal('ON_HOLD'),
    holdReason: reason('Say why the project is on hold'),
    startDate: calendarDateSchema.optional(),
  }),
  idOnlySchema.extend({
    to: z.literal('COMPLETED'),
    completedDate: pastDay('Enter the date the project was completed'),
  }),
  idOnlySchema.extend({
    to: z.literal('CANCELLED'),
    cancelReason: reason('Say why the project was cancelled'),
  }),
]);

export const PROJECT_SORTS = [
  'createdAt',
  'number',
  'name',
  'client',
  'manager',
  'status',
  'completionPct',
  'startDate',
  'endDate',
  'revenue',
  'updatedAt',
] as const;

/** `managerId=none` lists unassigned projects. */
export const UNASSIGNED = 'none';

export const listProjectsSchema = listParamsSchema.extend({
  status: multi(PROJECT_STATUSES),
  currency: z.preprocess((value) => {
    const list = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(list)) return list;
    const cleaned = list.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  }, z.array(currencySchema).optional()),
  managerId: z.string().min(1).optional(),
  /** The quotation's owner (admins only; checked in the service). */
  ownerId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  quotationId: z.string().min(1).optional(),
  startFrom: calendarDateSchema.optional(),
  startTo: calendarDateSchema.optional(),
  endFrom: calendarDateSchema.optional(),
  endTo: calendarDateSchema.optional(),
  /** Open, with a planned end before today (Asia/Kolkata). */
  behindSchedule: flag,
  recordStatus: recordStatusSchema,
  sort: z.enum(PROJECT_SORTS).optional(),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;
export type ChangeProjectStatusInput = z.input<typeof changeProjectStatusSchema>;
export type ListProjectsInput = z.input<typeof listProjectsSchema>;

// Server-action transport shapes.
export const updateProjectActionSchema = withId(updateProjectFormSchema);
export const projectIdActionSchema = idOnlySchema;
