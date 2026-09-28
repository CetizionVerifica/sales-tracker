import { can, getClient, listUsers, NotFoundError } from '@sales-tracker/core';
import {
  MY_TODAY_KIND_GROUPS,
  myTodayKindGroupSchema,
  toCalendarDateString,
  type MyToday,
  type MyTodayKindGroup,
} from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { EmptyState } from '@/components/feedback/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireUser } from '@/lib/auth';
import { loadMyToday } from '@/lib/my-today';
import { MY_TODAY_GROUP_LABELS } from '@/lib/my-today-labels';
import type { SearchParams } from '@/lib/list-params';
import { cn } from '@/lib/utils';
import { TodaySection } from './TodaySection';
import { ViewingSelect } from './ViewingSelect';
import { toRowView, type TodayRowView } from './today-view';

export const metadata = { title: 'My today · Sales Tracker' };

const GROUPS = myTodayKindGroupSchema.options;

/** "Monday, 28 September" for the IST day the service computed (UTC midnight). */
const heading = (day: Date) =>
  new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(day);

async function load(userId: string | undefined, kind: MyTodayKindGroup | undefined) {
  try {
    return await loadMyToday(userId, kind);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

/**
 * My today (M11, UI guide 4.4): what needs the user, in three panels by due date. Admins can
 * view another user's list, read-only (Decision 6).
 */
export default async function TodayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireUser();
  const params = await searchParams;
  const userParam = typeof params.user === 'string' ? params.user : undefined;
  // An unknown chip is ignored rather than an error: the URL is user-editable.
  const parsedKind = myTodayKindGroupSchema.safeParse(params.kind);
  const kind = parsedKind.success ? parsedKind.data : null;
  const isAdmin = can(ctx.user, 'list', 'user');

  const [result, users] = await Promise.all([
    load(userParam === ctx.user.id ? undefined : userParam, kind ?? undefined),
    isAdmin ? listUsers(ctx, { status: 'active', sort: 'name', pageSize: 100 }) : null,
  ]);
  const today = toCalendarDateString(result.today);

  const pick = (rows: MyToday['sections']['overdue']): TodayRowView[] => rows.map(toRowView);
  const sections = {
    overdue: pick(result.sections.overdue),
    dueToday: pick(result.sections.dueToday),
    comingUp: pick(result.sections.comingUp),
  };
  // Exact, and already narrowed to the chip by the service.
  const total = (section: keyof typeof sections) => result.counts[section];

  // Contacts for the follow-up sheet, one read per client on the list.
  const clientIds = [
    ...new Set(
      Object.values(sections)
        .flat()
        .filter((row) => row.actions.includes('LOG_FOLLOW_UP'))
        .map((row) => row.client.id),
    ),
  ];
  const contacts = Object.fromEntries(
    await Promise.all(
      clientIds.map(async (id) => {
        const client = await getClient(ctx, id);
        return [id, client.contacts.map((c) => ({ id: c.id, name: c.name }))] as const;
      }),
    ),
  );

  const base = result.viewingOther ? `/today?user=${result.user.id}` : '/today';
  const withKind = (group: MyTodayKindGroup | null) =>
    group ? `${base}${base.includes('?') ? '&' : '?'}kind=${group}` : base;
  const groupCount = (group: MyTodayKindGroup) =>
    MY_TODAY_KIND_GROUPS[group].reduce((sum, k) => sum + result.counts.byKind[k], 0);
  const all = Object.values(result.counts.byKind).reduce((sum, n) => sum + n, 0);

  const more = (section: keyof typeof sections) =>
    total(section) > sections[section].length ? (
      <>
        Showing {sections[section].length} of {total(section)}. The rest are in{' '}
        <Link className="underline" href="/invoices?due=overdue">
          Invoices
        </Link>
        ,{' '}
        <Link className="underline" href="/quotations?followUpDue=true">
          Quotations
        </Link>{' '}
        and{' '}
        <Link className="underline" href="/enquiries?stale=true">
          Enquiries
        </Link>
        .
      </>
    ) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="My today"
        description={
          result.viewingOther
            ? `${heading(result.today)} · ${result.user.name}, read-only`
            : heading(result.today)
        }
        actions={
          users && (
            <ViewingSelect
              meId={ctx.user.id}
              value={result.user.id}
              users={users.items.map((u) => ({ id: u.id, name: u.name }))}
            />
          )
        }
      />

      {all > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Filter by type">
          {[null, ...GROUPS].map((group) => {
            const count = group ? groupCount(group) : all;
            if (group && count === 0) return null;
            const active = group === kind;
            return (
              <li key={group ?? 'all'}>
                <Link
                  href={withKind(group)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'bg-card hover:bg-accent inline-flex items-center gap-2 rounded-[var(--radius-control)] border px-3 py-1.5 text-[13px]',
                    active && 'border-primary bg-secondary',
                  )}
                >
                  <span>{group ? MY_TODAY_GROUP_LABELS[group] : 'All'}</span>
                  <span className="num font-semibold">{count}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {all === 0 ? (
        <Panel>
          <EmptyState
            message={
              result.viewingOther
                ? `${result.user.name} is clear for today.`
                : "You're clear for today."
            }
          />
        </Panel>
      ) : (
        <>
          <TodaySection
            id="today-overdue"
            title="Overdue"
            attention
            total={total('overdue')}
            rows={sections.overdue}
            today={today}
            contacts={contacts}
            emptyText="Nothing overdue."
            footer={more('overdue')}
          />
          <TodaySection
            id="today-due"
            title="Due today"
            attention
            total={total('dueToday')}
            rows={sections.dueToday}
            today={today}
            contacts={contacts}
            emptyText="Nothing due today."
            footer={more('dueToday')}
          />
          <TodaySection
            id="today-coming-up"
            title="Coming up"
            attention={false}
            total={total('comingUp')}
            rows={sections.comingUp}
            today={today}
            contacts={contacts}
            emptyText="Nothing in the next 7 days."
            footer={more('comingUp')}
          />
        </>
      )}
    </div>
  );
}
