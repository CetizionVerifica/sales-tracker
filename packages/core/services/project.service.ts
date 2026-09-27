import type { Prisma, ProjectStatus } from '@sales-tracker/db';
import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Actor, type Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { can } from '../rbac/can.ts';
import {
  projectAccessSelect,
  projectResource,
  quotationManagersSelect,
  quotationResource,
  scopeProjects,
} from '../rbac/scope.ts';
import type { Action } from '../rbac/types.ts';
import { todayInIST, type Page } from '../schemas/common.ts';
import {
  ADMIN_ONLY_PROJECT_FIELDS,
  changeProjectStatusSchema,
  createProjectSchema,
  END_BEFORE_START,
  listProjectsSchema,
  UNASSIGNED,
  updateProjectSchema,
  type ChangeProjectStatusInput,
  type CreateProjectInput,
  type ListProjectsInput,
  type UpdateProjectInput,
} from '../schemas/project.ts';
import {
  ACTIVE_PROJECT_STATUSES,
  assertProjectTransition,
  CLOSED_PROJECT_EDITABLE,
  isActiveProject,
  isBehindSchedule,
} from '../status/project.ts';
import { nextNumber } from './number-sequence.ts';
import { SETTINGS_ID } from './settings.service.ts';
import { guardUnique } from './unique.ts';

// Relations loaded with `include` are not soft-delete filtered, so a retired service or a
// deactivated manager still shows its name on existing projects (as in M3 AC12).
const projectInclude = {
  client: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true, active: true } },
  quotation: {
    select: {
      id: true,
      number: true,
      ownerId: true,
      amountMinor: true,
      currency: true,
      poReceivedDate: true,
      owner: { select: { id: true, name: true } },
      enquiry: { select: { id: true, number: true } },
    },
  },
  services: {
    select: { service: { select: { id: true, name: true } } },
    orderBy: { service: { name: 'asc' } },
  },
} satisfies Prisma.ProjectInclude;

type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

/** A project with its client, manager, quotation and services flattened for display. */
export type ProjectDetail = Omit<ProjectRow, 'services'> & {
  services: { id: string; name: string }[];
  /** Open, with a planned end before today (Asia/Kolkata). */
  behindSchedule: boolean;
};

/** Fields the assigned PM may change (M8 Decision 6); admins may change these and more. */
const PM_EDITABLE = ['name', 'startDate', 'endDate', 'completionPct', 'description'] as const;
const ALL_EDITABLE = [...PM_EDITABLE, ...ADMIN_ONLY_PROJECT_FIELDS] as const;
export type ProjectEditableField = (typeof ALL_EDITABLE)[number];

/** What the actor may do on the project page. */
export interface ProjectPermissions {
  canUpdate: boolean;
  canChangeStatus: boolean;
  /** Admin-only (M8 Decision 12). */
  canCancel: boolean;
  canReassign: boolean;
  canDelete: boolean;
  editableFields: readonly ProjectEditableField[];
}

export type ProjectView = ProjectDetail & { permissions: ProjectPermissions };

function toDetail({ services, ...row }: ProjectRow, today = todayInIST()): ProjectDetail {
  return {
    ...row,
    services: services.map((link) => link.service),
    behindSchedule: isBehindSchedule(row, today),
  };
}

/** Includes a soft-deleted project (detail page with Restore). */
async function loadProject(db: Db, id: string): Promise<ProjectDetail> {
  const row = await db.project.findFirst({
    where: { id, deletedAt: undefined },
    include: projectInclude,
  });
  if (!row) throw new NotFoundError('project');
  return toDetail(row);
}

export function projectPermissions(
  user: Actor,
  project: { status: ProjectStatus; managerId: string | null; quotation: { ownerId: string } },
): ProjectPermissions {
  const resource = projectResource(project);
  const canUpdate = can(user, 'update', resource);
  const active = isActiveProject(project.status);
  const admin = user.role === 'ADMIN';
  let editableFields: readonly ProjectEditableField[] = [];
  if (canUpdate) {
    if (!active) editableFields = CLOSED_PROJECT_EDITABLE as ProjectEditableField[];
    else editableFields = admin ? ALL_EDITABLE : PM_EDITABLE;
  }
  return {
    canUpdate,
    canChangeStatus: canUpdate && active,
    canCancel: admin && active,
    canReassign: admin && active,
    canDelete: can(user, 'delete', resource),
    editableFields,
  };
}

const accessSelect = {
  id: true,
  number: true,
  quotationId: true,
  status: true,
  startDate: true,
  endDate: true,
  currency: true,
  services: { select: { id: true, serviceId: true } },
  ...projectAccessSelect,
} satisfies Prisma.ProjectSelect;

const ROW_FILTER = {
  live: {},
  deleted: { deletedAt: { not: null } },
  any: { deletedAt: undefined },
} as const;

/**
 * Loads the ownership fields and checks `action`. A project the user cannot read is
 * reported as not found, so other people's ids don't leak (M4 Decision 7).
 */
async function findAccessible(
  db: Db,
  ctx: Ctx,
  id: string,
  action: Action,
  rows: keyof typeof ROW_FILTER = 'live',
) {
  const row = await db.project.findFirst({
    where: { id, ...ROW_FILTER[rows] },
    select: accessSelect,
  });
  if (!row || !can(ctx.user, 'read', projectResource(row))) throw new NotFoundError('project');
  assertCan(ctx, action, projectResource(row));
  return row;
}

// ─── Checks on referenced records ───────────────────────────────────────────────────

/** The manager must be an active project manager (M8 Decision 5). */
async function assertManagerAllowed(db: Db, managerId: string) {
  const manager = await db.user.findFirst({
    where: { id: managerId, active: true, isSystem: false, role: 'PROJECT_MANAGER' },
    select: { id: true },
  });
  if (!manager) {
    throw new DomainError('Choose an active project manager', { field: 'managerId' });
  }
}

async function assertServicesUsable(db: Db, serviceIds: string[]) {
  if (serviceIds.length === 0) return;
  const found = await db.service.count({ where: { id: { in: serviceIds }, active: true } });
  if (found !== serviceIds.length) {
    throw new DomainError('Choose active services', { field: 'serviceIds' });
  }
}

async function assertCurrencyEnabled(db: Db, currency: string) {
  const settings = await db.companySettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { enabledCurrencies: true },
  });
  if (!settings) throw new Error('Company settings are missing; run `pnpm db:seed`');
  if (!settings.enabledCurrencies.includes(currency)) {
    throw new DomainError(`${currency} is not enabled in company settings`, {
      field: 'currency',
    });
  }
}

/** The live project on a quotation, if any (M8 Decision 2). */
function liveProjectOn(db: Db, quotationId: string) {
  return db.project.findFirst({ where: { quotationId }, select: { id: true, number: true } });
}

const ALREADY_HAS_PROJECT = 'This quotation already has a project';

// ─── Reads ──────────────────────────────────────────────────────────────────────────

const SORT_COLUMNS = {
  createdAt: (dir) => ({ createdAt: dir }),
  number: (dir) => ({ number: dir }),
  name: (dir) => ({ name: dir }),
  client: (dir) => ({ client: { name: dir } }),
  manager: (dir) => ({ manager: { name: dir } }),
  status: (dir) => ({ status: dir }),
  completionPct: (dir) => ({ completionPct: dir }),
  startDate: (dir) => ({ startDate: { sort: dir, nulls: 'last' } }),
  endDate: (dir) => ({ endDate: { sort: dir, nulls: 'last' } }),
  // Minor units across currencies are not comparable; the list notes this (M12 converts).
  revenue: (dir) => ({ revenueMinor: dir }),
  updatedAt: (dir) => ({ updatedAt: dir }),
} satisfies Record<string, (dir: Prisma.SortOrder) => Prisma.ProjectOrderByWithRelationInput>;

const between = (from: Date | undefined, to: Date | undefined) =>
  from || to ? { ...(from && { gte: from }), ...(to && { lte: to }) } : undefined;

export async function listProjects(
  ctx: Ctx,
  input: ListProjectsInput,
): Promise<Page<ProjectDetail>> {
  const p = listProjectsSchema.parse(input);
  assertCan(ctx, 'list', 'project');
  if (p.ownerId && ctx.user.role !== 'ADMIN') {
    throw new DomainError('Only admins can filter by owner', { field: 'ownerId' });
  }

  const today = todayInIST();
  const contains = p.q ? { contains: p.q, mode: 'insensitive' as const } : undefined;
  const filters: Prisma.ProjectWhereInput[] = [
    {
      ...(p.status && { status: { in: p.status } }),
      ...(p.currency && { currency: { in: p.currency } }),
      ...(p.managerId && { managerId: p.managerId === UNASSIGNED ? null : p.managerId }),
      ...(p.ownerId && { quotation: { ownerId: p.ownerId } }),
      ...(p.clientId && { clientId: p.clientId }),
      ...(p.quotationId && { quotationId: p.quotationId }),
      ...(p.serviceId && { services: { some: { serviceId: p.serviceId } } }),
      ...(between(p.startFrom, p.startTo) && { startDate: between(p.startFrom, p.startTo) }),
      ...(between(p.endFrom, p.endTo) && { endDate: between(p.endFrom, p.endTo) }),
      ...(contains && {
        OR: [
          { number: contains },
          { name: contains },
          { quotation: { number: contains } },
          { client: { name: contains } },
          { cancelReason: contains },
        ],
      }),
    },
  ];
  if (p.behindSchedule) {
    filters.push({ status: { in: [...ACTIVE_PROJECT_STATUSES] }, endDate: { lt: today } });
  }
  // `deletedAt` stays top-level: that is the soft-delete extension's opt-in (M3).
  const where: Prisma.ProjectWhereInput = {
    ...(p.recordStatus === 'deleted' && { deletedAt: { not: null } }),
    AND: [scopeProjects(ctx.user), ...filters],
  };
  const dir = p.dir ?? (p.sort ? 'asc' : 'desc');
  const db = getDb();

  const [rows, total] = await Promise.all([
    db.project.findMany({
      where,
      include: projectInclude,
      orderBy: [SORT_COLUMNS[p.sort ?? 'createdAt'](dir), { createdAt: 'desc' }, { id: 'asc' }],
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
    }),
    db.project.count({ where }),
  ]);
  return {
    items: rows.map((row) => toDetail(row, today)),
    total,
    page: p.page,
    pageSize: p.pageSize,
  };
}

/** Includes a soft-deleted project the user can see (restore view). */
export async function getProject(ctx: Ctx, id: string): Promise<ProjectView> {
  await findAccessible(getDb(), ctx, id, 'read', 'any');
  const project = await loadProject(getDb(), id);
  return { ...project, permissions: projectPermissions(ctx.user, project) };
}

/** Live projects on a quotation the user can see (quotation page). */
export async function listProjectsForQuotation(
  ctx: Ctx,
  quotationId: string,
): Promise<ProjectDetail[]> {
  assertCan(ctx, 'list', 'project');
  const rows = await getDb().project.findMany({
    where: { quotationId, AND: [scopeProjects(ctx.user)] },
    include: projectInclude,
    orderBy: { number: 'desc' },
  });
  const today = todayInIST();
  return rows.map((row) => toDetail(row, today));
}

/** The ten latest live projects on a client the user can see (client page). */
export async function listProjectsForClient(ctx: Ctx, clientId: string): Promise<ProjectDetail[]> {
  assertCan(ctx, 'list', 'project');
  const rows = await getDb().project.findMany({
    where: { clientId, AND: [scopeProjects(ctx.user)] },
    include: projectInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 10,
  });
  const today = todayInIST();
  return rows.map((row) => toDetail(row, today));
}

/** Manager picker: active project managers, for anyone who can create or reassign projects. */
export async function listProjectManagerOptions(ctx: Ctx): Promise<{ id: string; name: string }[]> {
  assertCan(ctx, 'create', 'project');
  return getDb().user.findMany({
    where: { active: true, isSystem: false, role: 'PROJECT_MANAGER' },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

// ─── Writes ─────────────────────────────────────────────────────────────────────────

/**
 * Starts NOT_STARTED at 0% from a PO_RECEIVED quotation the user can read (M8 Decision 1),
 * by its Sales owner or an admin. The client is the quotation's (Decision 3). Services and
 * currency are checked only where they differ from the quotation's, so a quotation in a
 * since-retired service can still become a project.
 */
export async function createProject(ctx: Ctx, input: CreateProjectInput): Promise<ProjectDetail> {
  const { quotationId, serviceIds, managerId, ...fields } = createProjectSchema.parse(input);
  assertCan(ctx, 'create', 'project');
  return guardUnique('quotationId', ALREADY_HAS_PROJECT, () =>
    withTx(ctx, async (tx) => {
      const quotation = await tx.quotation.findFirst({
        where: { id: quotationId },
        select: {
          id: true,
          ownerId: true,
          clientId: true,
          status: true,
          currency: true,
          client: { select: { deletedAt: true } },
          services: { select: { serviceId: true } },
          ...quotationManagersSelect,
        },
      });
      if (
        !quotation ||
        quotation.client.deletedAt ||
        !can(ctx.user, 'read', quotationResource(quotation))
      ) {
        throw new NotFoundError('quotation');
      }
      if (quotation.status !== 'PO_RECEIVED') {
        throw new DomainError('Only a quotation with a PO received can start a project', {
          field: 'quotationId',
        });
      }
      const existing = await liveProjectOn(tx, quotationId);
      if (existing) {
        throw new DomainError(`${ALREADY_HAS_PROJECT} (${existing.number})`, {
          field: 'quotationId',
        });
      }

      assertCan(
        ctx,
        'create',
        projectResource({
          managerId: managerId ?? null,
          quotation: { ownerId: quotation.ownerId },
        }),
      );
      if (managerId) await assertManagerAllowed(tx, managerId);
      const fromQuotation = new Set(quotation.services.map((s) => s.serviceId));
      await assertServicesUsable(
        tx,
        serviceIds.filter((id) => !fromQuotation.has(id)),
      );
      if (fields.currency !== quotation.currency) await assertCurrencyEnabled(tx, fields.currency);

      const number = await nextNumber(tx, 'PRJ', todayInIST().getUTCFullYear());
      const { id } = await tx.project.create({
        data: {
          ...fields,
          quotationId,
          clientId: quotation.clientId,
          managerId: managerId ?? null,
          number,
          status: 'NOT_STARTED',
          completionPct: 0,
          statusChangedAt: new Date(),
        },
        select: { id: true },
      });
      // One row per service: M2 rejects nested writes, and each link is audited.
      for (const serviceId of serviceIds) {
        await tx.projectService.create({ data: { projectId: id, serviceId } });
      }
      return loadProject(tx, id);
    }),
  );
}

/**
 * Edited in place; the audit log is the history. The assigned PM changes delivery fields,
 * admins everything (M8 Decision 6); a completed or cancelled project takes only a
 * description. Services and currency are re-checked only when they change.
 */
export async function updateProject(
  ctx: Ctx,
  id: string,
  input: UpdateProjectInput,
): Promise<ProjectDetail> {
  const { serviceIds, ...fields } = updateProjectSchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'update');
    const { editableFields } = projectPermissions(ctx.user, current);

    // `revenueMinor` is reported as `revenue`, the field people edit.
    const touched = [
      ...Object.keys(fields).map((key) => (key === 'revenueMinor' ? 'revenue' : key)),
      ...(serviceIds ? ['serviceIds'] : []),
    ];
    const locked = touched.filter((key) => !editableFields.includes(key as ProjectEditableField));
    if (locked.length > 0) {
      // The revenue (with its currency) is the field people try to change; point at it.
      const field = locked.includes('revenue') ? 'revenue' : locked[0]!;
      throw new DomainError(
        isActiveProject(current.status)
          ? 'Only an admin can change this'
          : 'A closed project only takes description changes',
        { field },
      );
    }

    if (fields.managerId && fields.managerId !== current.managerId) {
      await assertManagerAllowed(tx, fields.managerId);
    }
    if (fields.currency !== undefined && fields.currency !== current.currency) {
      await assertCurrencyEnabled(tx, fields.currency);
    }

    const startDate = fields.startDate !== undefined ? fields.startDate : current.startDate;
    const endDate = fields.endDate !== undefined ? fields.endDate : current.endDate;
    // Started projects keep a start date; one cancelled before starting may have none (the
    // DB CHECK mirrors this).
    if (current.status !== 'NOT_STARTED' && current.status !== 'CANCELLED') {
      if (!startDate) {
        throw new DomainError('A started project needs a start date', { field: 'startDate' });
      }
      if (fields.startDate && fields.startDate > todayInIST()) {
        throw new DomainError('A started project cannot start in the future', {
          field: 'startDate',
        });
      }
    }
    if (startDate && endDate && endDate < startDate) {
      throw new DomainError(END_BEFORE_START, { field: 'endDate' });
    }

    if (serviceIds) {
      const wanted = new Set(serviceIds);
      const have = new Set(current.services.map((link) => link.serviceId));
      const added = serviceIds.filter((serviceId) => !have.has(serviceId));
      const removed = current.services.filter((link) => !wanted.has(link.serviceId));
      await assertServicesUsable(tx, added);
      if (removed.length > 0) {
        await tx.projectService.deleteMany({
          where: { id: { in: removed.map((link) => link.id) } },
        });
      }
      for (const serviceId of added) {
        await tx.projectService.create({ data: { projectId: id, serviceId } });
      }
    }

    // Guarded on the status and manager that were read: a status change or reassignment
    // committed since must still apply its rules (AC13).
    await guardedUpdate(
      tx,
      id,
      { status: current.status, managerId: current.managerId, deletedAt: null },
      fields,
    );
    return loadProject(tx, id);
  });
}

export const CONCURRENT_PROJECT_CHANGE = 'Someone else changed this project. Reload and try again.';

/**
 * Writes only if the row still looks the way the caller read it (the M4 code-review fix):
 * the conditional UPDATE re-checks `expected` under the row lock, so the second of two racing
 * requests updates nothing and fails; its transaction, with any audit row, rolls back. An
 * empty `data` still checks the row, so a services-only edit is guarded too.
 */
async function guardedUpdate(
  tx: Db,
  id: string,
  expected: Prisma.ProjectWhereInput,
  data: Prisma.ProjectUpdateManyMutationInput,
) {
  const where = { ...expected, id };
  const count =
    Object.keys(data).length > 0
      ? (await tx.project.updateMany({ where, data })).count
      : await tx.project.count({ where });
  if (count === 0) throw new DomainError(CONCURRENT_PROJECT_CHANGE);
}

/** Moves a project through its status machine; cancelling is admin-only (Decision 12). */
export async function changeProjectStatus(
  ctx: Ctx,
  input: ChangeProjectStatusInput,
): Promise<ProjectDetail> {
  const p = changeProjectStatusSchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, p.id, 'update');
    // Cancelling is admin-only (M8 Decision 12), checked on its own so it doesn't follow
    // whoever may delete projects if that policy changes.
    if (p.to === 'CANCELLED' && ctx.user.role !== 'ADMIN') {
      throw new ForbiddenError('cancel', 'project');
    }
    assertProjectTransition(current, p.to, { ...p, today: todayInIST() });

    const data: Prisma.ProjectUpdateManyMutationInput = {
      status: p.to,
      statusChangedAt: new Date(),
    };
    if ((p.to === 'IN_PROGRESS' || p.to === 'ON_HOLD') && p.startDate) {
      data.startDate = p.startDate;
    }
    if (p.to === 'ON_HOLD') data.holdReason = p.holdReason;
    if (p.to === 'COMPLETED') {
      data.completedDate = p.completedDate;
      data.completionPct = 100;
    }
    if (p.to === 'CANCELLED') data.cancelReason = p.cancelReason;
    await guardedUpdate(
      tx,
      p.id,
      { status: current.status, managerId: current.managerId, deletedAt: null },
      data,
    );
    return loadProject(tx, p.id);
  });
}

/**
 * Admins only (M1 policy). Deleting frees the quotation for a new project.
 * TODO(M9): refuse while the project has live purchase orders.
 */
export async function softDeleteProject(ctx: Ctx, id: string): Promise<ProjectDetail> {
  return withTx(ctx, async (tx) => {
    await findAccessible(tx, ctx, id, 'delete');
    await guardedUpdate(tx, id, { deletedAt: null }, { deletedAt: new Date() });
    return loadProject(tx, id);
  });
}

/** Restores only while the quotation is live and has no other live project. */
export async function restoreProject(ctx: Ctx, id: string): Promise<ProjectDetail> {
  return guardUnique('quotationId', ALREADY_HAS_PROJECT, () =>
    withTx(ctx, async (tx) => {
      const current = await findAccessible(tx, ctx, id, 'delete', 'deleted');
      const quotation = await tx.quotation.findFirst({
        where: { id: current.quotationId },
        select: { id: true },
      });
      if (!quotation) throw new DomainError('Restore the quotation before its project');
      const existing = await liveProjectOn(tx, current.quotationId);
      if (existing) {
        throw new DomainError(`${ALREADY_HAS_PROJECT} (${existing.number})`, {
          field: 'quotationId',
        });
      }
      await guardedUpdate(tx, id, { deletedAt: { not: null } }, { deletedAt: null });
      return loadProject(tx, id);
    }),
  );
}
