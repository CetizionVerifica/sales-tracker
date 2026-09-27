import {
  can,
  getSettings,
  listClientOptions,
  listEnquiryOwnerOptions,
  listProjectManagerOptions,
  listProjects,
  listServiceOptions,
  projectResource,
  projectStatusCounts,
} from '@sales-tracker/core';
import { listProjectsSchema, UNASSIGNED } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { DateRangeFilter } from '@/components/data/DateRangeFilter';
import { FilterBar, type FilterDef } from '@/components/data/FilterBar';
import { SummaryStrip } from '@/components/data/SummaryStrip';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { istToday } from '@/lib/display';
import { toOptions } from '@/lib/enquiry-labels';
import { filterKeys, isOnlyFilter, parseListParams, type SearchParams } from '@/lib/list-params';
import { isOpenProject, PROJECT_STATUS_LABELS } from '@/lib/project-labels';
import { ProjectsTable } from './ProjectsTable';

export const metadata = { title: 'Projects · Sales Tracker' };

const asOptions = (rows: { id: string; name: string }[]) =>
  rows.map((row) => ({ value: row.id, label: row.name }));

/**
 * Admins see every project, Sales the projects on their quotations, PMs only the ones
 * assigned to them (the M8 "done when"). Projects start from a quotation, so "New project"
 * opens the quotations still waiting for one (M8 Decision 1).
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'project')) return <NoAccess />;
  const params = parseListParams(await searchParams, listProjectsSchema);
  const isAdmin = can(ctx.user, 'list', 'user');
  const canCreate = can(ctx.user, 'create', 'project');

  const [result, counts, clients, services, settings, managers, owners] = await Promise.all([
    listProjects(ctx, isAdmin ? params : { ...params, ownerId: undefined }),
    projectStatusCounts(ctx),
    listClientOptions(ctx),
    listServiceOptions(ctx),
    getSettings(ctx),
    // PMs see only their own projects, so they get no manager filter.
    canCreate ? listProjectManagerOptions(ctx) : null,
    isAdmin ? listEnquiryOwnerOptions(ctx) : null,
  ]);
  const today = istToday();
  const raw = await searchParams;
  const filtered = filterKeys(raw).length > 0;
  const only = (key: string, value: string) => isOnlyFilter(raw, key, value);

  const filters: FilterDef[] = [
    {
      param: 'status',
      label: 'Statuses',
      options: toOptions(PROJECT_STATUS_LABELS),
      multi: true,
    },
    {
      param: 'behindSchedule',
      label: 'Schedule',
      options: [{ value: 'true', label: 'Behind schedule' }],
    },
    ...(managers
      ? [
          {
            param: 'managerId',
            label: 'Managers',
            options: [{ value: UNASSIGNED, label: 'Unassigned' }, ...asOptions(managers)],
          },
        ]
      : []),
    ...(owners ? [{ param: 'ownerId', label: 'Owners', options: asOptions(owners) }] : []),
    { param: 'clientId', label: 'Clients', options: asOptions(clients) },
    { param: 'serviceId', label: 'Services', options: asOptions(services) },
    {
      param: 'currency',
      label: 'Currencies',
      multi: true,
      options: settings.enabledCurrencies.map((code) => ({ value: code, label: code })),
    },
    ...(isAdmin
      ? [
          {
            param: 'recordStatus',
            label: 'Records',
            options: [{ value: 'deleted', label: 'Deleted' }],
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Projects"
        description="Deliver the work behind every PO, from kick-off to completion"
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/quotations?status=PO_RECEIVED&hasProject=false">New project</Link>
            </Button>
          )
        }
      />
      <SummaryStrip
        chips={[
          {
            label: 'Behind schedule',
            count: counts.behindSchedule,
            href: '/projects?behindSchedule=true',
            active: only('behindSchedule', 'true'),
            attention: true,
          },
          {
            label: 'Not started',
            count: counts.NOT_STARTED,
            href: '/projects?status=NOT_STARTED',
            active: only('status', 'NOT_STARTED'),
          },
          {
            label: 'In progress',
            count: counts.IN_PROGRESS,
            href: '/projects?status=IN_PROGRESS',
            active: only('status', 'IN_PROGRESS'),
          },
          {
            label: 'On hold',
            count: counts.ON_HOLD,
            href: '/projects?status=ON_HOLD',
            active: only('status', 'ON_HOLD'),
          },
        ]}
      />
      <FilterBar searchPlaceholder="Search number, name, quotation, client" filters={filters}>
        <DateRangeFilter label="Start" fromParam="startFrom" toParam="startTo" />
        <DateRangeFilter label="Planned end" fromParam="endFrom" toParam="endTo" />
      </FilterBar>
      {params.sort === 'revenue' && (
        <p className="text-muted-foreground text-[13px]">
          Revenue in different currencies is sorted by face value, not converted.
        </p>
      )}
      <ProjectsTable
        rows={result.items.map((p) => ({
          id: p.id,
          number: p.number,
          name: p.name,
          client: p.client.name,
          quotationId: p.quotation.id,
          quotationNumber: p.quotation.number,
          manager: p.manager?.name ?? null,
          status: p.status,
          completionPct: p.completionPct,
          endDate: p.endDate?.toISOString() ?? null,
          open: isOpenProject(p.status),
          revenueMinor: p.revenueMinor.toString(),
          currency: p.currency,
          updatedAt: p.updatedAt.toISOString(),
          deleted: p.deletedAt !== null,
          canRestore: can(ctx.user, 'delete', projectResource(p)),
        }))}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        sort={params.sort}
        dir={params.dir}
        today={today}
        filtered={filtered}
        canCreate={canCreate}
      />
    </>
  );
}
