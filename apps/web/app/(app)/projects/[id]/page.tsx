import {
  can,
  getClient,
  getClientTimeline,
  listProjectManagerOptions,
  purchaseOrderResource,
} from '@sales-tracker/core';
import { toCalendarDateString } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { RecordAudit } from '@/components/audit/RecordAudit';
import { Panel } from '@/components/charts/Panel';
import { DateDisplay } from '@/components/display/DateDisplay';
import { FieldGrid } from '@/components/display/FieldGrid';
import { Money } from '@/components/display/Money';
import { Progress } from '@/components/display/Progress';
import { RelativeDue } from '@/components/display/RelativeDue';
import { UserAvatar } from '@/components/display/UserAvatar';
import { EmptyState } from '@/components/feedback/EmptyState';
import { DetailLayout } from '@/components/layout/DetailLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { RecordMenu, type RecordMenuItem } from '@/components/layout/RecordMenu';
import { RecordTabs } from '@/components/layout/RecordTabs';
import { PipelineStrip } from '@/components/pipeline/PipelineStrip';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { FollowUpSheet } from '@/components/timeline/FollowUpSheet';
import { Timeline } from '@/components/timeline/Timeline';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { EXTRACTION_STATUS_TEXT } from '@/lib/document-labels';
import { istToday } from '@/lib/display';
import { isOpenProject } from '@/lib/project-labels';
import { loadRecordAudit } from '@/lib/record-audit';
import { deleteProjectAction, restoreProjectAction } from '../actions';
import { loadProjectOr404 } from '../load';
import { ProjectStatusDialog, ReassignDialog, UpdateProgress } from './ProjectActions';
import { ProjectPurchaseOrders } from './ProjectPurchaseOrders';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const project = await loadProjectOr404(ctx, (await params).id);
  const { permissions } = project;
  const deleted = project.deletedAt !== null;
  const open = isOpenProject(project.status);
  const canChange = !deleted && permissions.canChangeStatus;
  const today = istToday();
  const startDate = project.startDate ? toCalendarDateString(project.startDate) : '';

  const query = {
    clientId: project.client.id,
    entityType: 'PROJECT' as const,
    entityId: project.id,
  };
  const [timeline, client, audit, managers] = await Promise.all([
    getClientTimeline(ctx, query),
    getClient(ctx, project.client.id),
    loadRecordAudit(ctx, 'Project', project.id),
    !deleted && permissions.canReassign ? listProjectManagerOptions(ctx) : null,
  ]);
  const contacts = client.contacts.map((c) => ({ id: c.id, name: c.name }));
  const canLog = !deleted && client.deletedAt === null;
  const from = open ? (project.status as 'NOT_STARTED' | 'IN_PROGRESS' | 'ON_HOLD') : null;
  const status = (to: 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED') =>
    from && (
      <ProjectStatusDialog
        id={project.id}
        to={to}
        from={from}
        startDate={startDate}
        holdReason={project.holdReason}
        today={today}
      />
    );
  const revenueDiffers =
    project.revenueMinor !== project.quotation.amountMinor ||
    project.currency !== project.quotation.currency;
  // M9: POs are recorded on live, non-cancelled projects by the pipeline owner, PM or admins.
  const { purchaseOrders } = project;
  const canAddPo =
    !deleted &&
    project.status !== 'CANCELLED' &&
    can(ctx.user, 'create', purchaseOrderResource({ project }));
  const [onlyPo] = purchaseOrders.length === 1 ? purchaseOrders : [];

  const menu: RecordMenuItem[] = [];
  if (permissions.canDelete && !deleted) {
    menu.push({
      label: 'Delete',
      destructive: true,
      title: `Delete ${project.number}?`,
      description:
        'It disappears from the list, and its quotation can start a new project. You can restore it from the Deleted filter.',
      success: 'Project deleted',
      run: async () => {
        'use server';
        return deleteProjectAction({ id: project.id });
      },
    });
  }
  if (permissions.deleteBlockedReason && !deleted) {
    menu.push({
      label: 'Delete',
      destructive: true,
      blocked: true,
      title: `${project.number} has purchase orders`,
      description: `Delete its purchase orders first (${purchaseOrders.length}). A project with purchase orders cannot be deleted.`,
    });
  }
  if (permissions.canDelete && deleted) {
    menu.push({
      label: 'Restore',
      title: `Restore ${project.number}?`,
      description: 'The project comes back, if its quotation has no other project.',
      success: 'Project restored',
      run: async () => {
        'use server';
        return restoreProjectAction({ id: project.id });
      },
    });
  }

  const overview = (
    <>
      <Panel
        title="Progress"
        actions={
          !deleted &&
          open &&
          permissions.editableFields.includes('completionPct') && (
            <UpdateProgress id={project.id} value={project.completionPct} />
          )
        }
      >
        <div className="flex flex-col gap-4">
          <Progress value={project.completionPct} className="[&_[role=progressbar]]:w-full" />
          <FieldGrid
            items={[
              { label: 'Start', value: <DateDisplay value={project.startDate} /> },
              {
                label: 'Planned end',
                value: (
                  <RelativeDue date={project.endDate} today={today} active={open && !deleted} />
                ),
              },
              {
                label: 'Completed on',
                value: <DateDisplay value={project.completedDate} />,
                hidden: !project.completedDate,
              },
              {
                label:
                  project.status === 'ON_HOLD' ? 'On hold because' : 'Last put on hold because',
                value: project.holdReason,
                hidden: !project.holdReason,
                wide: true,
              },
              {
                label: 'Cancelled because',
                value: project.cancelReason,
                hidden: !project.cancelReason,
                wide: true,
              },
            ]}
          />
        </div>
      </Panel>
      <Panel title="Details">
        <FieldGrid
          items={[
            { label: 'Services', value: project.services.map((s) => s.name).join(', ') },
            {
              label: 'Revenue',
              value: (
                <Money
                  amountMinor={project.revenueMinor}
                  currency={project.currency}
                  className="text-base font-medium"
                />
              ),
            },
            {
              label: 'Scope and notes',
              value: <p className="whitespace-pre-line">{project.description}</p>,
              wide: true,
              hidden: !project.description,
            },
          ]}
        />
      </Panel>
      <ProjectPurchaseOrders
        projectId={project.id}
        purchaseOrders={purchaseOrders.map((po) => ({
          id: po.id,
          poNumber: po.poNumber,
          receivedDate: po.receivedDate.toISOString(),
          amountMinor: po.amountMinor.toString(),
          currency: po.currency,
          paymentTerms: po.paymentTerms,
          status: po.status,
          documentState: po.documentState,
        }))}
        totals={{
          byCurrency: project.poTotals.byCurrency.map((t) => ({
            currency: t.currency,
            amountMinor: t.amountMinor.toString(),
          })),
          currency: project.poTotals.currency,
          coveredMinor: project.poTotals.coveredMinor.toString(),
          revenueMinor: project.poTotals.revenueMinor.toString(),
          overCovered: project.poTotals.overCovered,
        }}
        canAdd={canAddPo}
      />
    </>
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Projects', href: '/projects' }, { label: project.number }]}
        title={`${project.number} · ${project.name}`}
        description={`${project.client.name} · ${project.services.map((s) => s.name).join(', ')}`}
        badge={
          <>
            <StatusBadge entity="project" status={project.status} />
            {deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
          </>
        }
        actions={
          <>
            {canLog && (
              <FollowUpSheet
                mode="create"
                triggerLabel="Log follow-up"
                triggerVariant="outline"
                targets={[
                  {
                    entityType: 'PROJECT',
                    entityId: project.id,
                    label: `${project.number} · ${project.name}`,
                  },
                ]}
                contacts={contacts}
                today={today}
              />
            )}
            {!deleted && permissions.editableFields.length > 0 && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/projects/${project.id}/edit`}>Edit</Link>
              </Button>
            )}
            {managers && (
              <ReassignDialog
                id={project.id}
                number={project.number}
                managerId={project.managerId}
                managers={
                  project.manager && !managers.some((m) => m.id === project.manager!.id)
                    ? [...managers, { ...project.manager, note: 'inactive' }]
                    : managers
                }
              />
            )}
            {canChange && project.status === 'NOT_STARTED' && status('ON_HOLD')}
            {canChange && project.status === 'IN_PROGRESS' && status('ON_HOLD')}
            {!deleted && permissions.canCancel && status('CANCELLED')}
            {canChange && project.status !== 'NOT_STARTED' && status('COMPLETED')}
            {canChange && project.status !== 'IN_PROGRESS' && status('IN_PROGRESS')}
            <RecordMenu label={project.number} items={menu} />
          </>
        }
      />
      <PipelineStrip
        current="project"
        reached={purchaseOrders.length > 0 ? 'po' : 'project'}
        links={{
          enquiry: `/enquiries/${project.quotation.enquiry.id}`,
          quotation: `/quotations/${project.quotation.id}`,
          // The PO when there is one, otherwise the section listing them (M9).
          po: onlyPo ? `/purchase-orders/${onlyPo.id}` : '?tab=overview#purchase-orders',
        }}
      />
      <DetailLayout
        main={
          <RecordTabs
            tabs={[
              { id: 'overview', label: 'Overview', content: overview },
              {
                id: 'timeline',
                label: 'Timeline',
                content: (
                  <Panel>
                    <Timeline
                      query={query}
                      initial={timeline}
                      me={{ id: ctx.user.id, isAdmin: can(ctx.user, 'list', 'user') }}
                      contacts={contacts}
                      today={today}
                      showRecord={false}
                    />
                  </Panel>
                ),
              },
              {
                id: 'documents',
                label: 'Documents',
                content: (
                  <Panel bodyClassName="p-0">
                    {purchaseOrders.every((po) => !po.document) ? (
                      <EmptyState message="No documents yet. Upload each client PO on its page." />
                    ) : (
                      <ul className="divide-y">
                        {purchaseOrders.flatMap(({ document: d, ...po }) =>
                          d
                            ? [
                                <li
                                  key={d.id}
                                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
                                >
                                  <a
                                    className="font-medium hover:underline"
                                    href={`/api/documents/${d.id}/file`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {d.originalFilename}
                                  </a>
                                  <Link
                                    className="text-muted-foreground text-[13px] hover:underline"
                                    href={`/purchase-orders/${po.id}`}
                                  >
                                    PO {po.poNumber}
                                  </Link>
                                  <span className="text-muted-foreground text-[13px]">
                                    {d.uploadedBy.name} · <DateDisplay value={d.createdAt} />
                                  </span>
                                  <span className="ml-auto text-[13px]">
                                    {d.reviewStatus === 'CONFIRMED'
                                      ? 'Confirmed'
                                      : EXTRACTION_STATUS_TEXT[d.extractionStatus]}
                                  </span>
                                </li>,
                              ]
                            : [],
                        )}
                      </ul>
                    )}
                  </Panel>
                ),
              },
              {
                id: 'audit',
                label: 'Audit',
                content: <RecordAudit rows={audit.rows} ownOnly={audit.ownOnly} />,
              },
            ]}
          />
        }
        side={
          <Panel title="Key facts">
            <FieldGrid
              columns={1}
              items={[
                {
                  label: 'Client',
                  value: (
                    <Link className="hover:underline" href={`/clients/${project.client.id}`}>
                      {project.client.name}
                    </Link>
                  ),
                },
                {
                  label: 'Project manager',
                  value: project.manager ? (
                    <UserAvatar name={project.manager.name} showName />
                  ) : (
                    <span className="text-muted-foreground">Unassigned</span>
                  ),
                },
                {
                  label: 'Quotation owner',
                  value: <UserAvatar name={project.quotation.owner.name} showName />,
                },
                {
                  label: 'Revenue',
                  value: (
                    <span className="flex flex-col">
                      <Money amountMinor={project.revenueMinor} currency={project.currency} />
                      {revenueDiffers && (
                        <span className="text-muted-foreground text-[13px]">
                          Quoted{' '}
                          <Money
                            amountMinor={project.quotation.amountMinor}
                            currency={project.quotation.currency}
                          />
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  label: 'Planned end',
                  value: (
                    <RelativeDue date={project.endDate} today={today} active={open && !deleted} />
                  ),
                },
                {
                  label: 'Quotation',
                  value: (
                    <Link className="hover:underline" href={`/quotations/${project.quotation.id}`}>
                      {project.quotation.number}
                    </Link>
                  ),
                },
                {
                  label: 'PO received on',
                  value: <DateDisplay value={project.quotation.poReceivedDate} />,
                },
                {
                  label: 'Status changed',
                  value: <DateDisplay value={project.statusChangedAt} withTime />,
                  hidden: !project.statusChangedAt,
                },
                { label: 'Created', value: <DateDisplay value={project.createdAt} withTime /> },
                { label: 'Updated', value: <DateDisplay value={project.updatedAt} withTime /> },
              ]}
            />
          </Panel>
        }
      />
    </>
  );
}
