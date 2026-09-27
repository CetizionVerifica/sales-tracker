import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { projectResource, scopeProjects } from '../rbac/scope.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import {
  changeProjectStatus,
  createProject,
  getProject,
  listProjectManagerOptions,
  listProjects,
  listProjectsForClient,
  listProjectsForQuotation,
  restoreProject,
  softDeleteProject,
  updateProject,
} from '../services/project.service.ts';
import {
  changeQuotationStatus,
  getProjectDraft,
  getQuotation,
  listQuotations,
  updateQuotation,
} from '../services/quotation.service.ts';
import { searchRecords } from '../services/search.service.ts';
import { updateService } from '../services/service.service.ts';
import { projectStatusCounts } from '../services/summary.service.ts';
import { deactivateUser } from '../services/user.service.ts';
import {
  auditOf,
  FAR_FUTURE,
  fieldOf,
  newProject,
  projectInput,
  projectWorld,
  rejection,
  sameRequest,
  wonQuotation,
  type ProjectWorld,
} from './project-fixtures.ts';
import { createTestUser } from './helpers.ts';

describe('projects (integration)', () => {
  let w: ProjectWorld;
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let pm: Ctx;
  let pm2: Ctx;

  beforeAll(async () => {
    w = await projectWorld();
    ({ admin, sales, sales2, pm, pm2 } = w);
  });
  afterAll(disconnectAll);

  /** Moves a project to IN_PROGRESS as its PM. */
  const start = (id: string, ctx: Ctx = pm) =>
    changeProjectStatus(ctx, { id, to: 'IN_PROGRESS', startDate: '2026-04-10' });

  describe('AC1: create', () => {
    it('creates a NOT_STARTED project from a PO_RECEIVED quotation, with a number and audit rows', async () => {
      const { quotation } = await wonQuotation(w);
      const project = await createProject(
        sales,
        projectInput(w, quotation.id, { description: 'Phase 1', endDate: FAR_FUTURE }),
      );

      expect(project).toMatchObject({
        status: 'NOT_STARTED',
        completionPct: 0,
        quotationId: quotation.id,
        clientId: w.acme,
        managerId: pm.user.id,
        revenueMinor: 12_500_050n,
        currency: 'INR',
        description: 'Phase 1',
        client: { id: w.acme, name: 'Acme Pharma' },
        manager: { id: pm.user.id },
        quotation: { id: quotation.id, number: quotation.number, ownerId: sales.user.id },
      });
      expect(project.number).toMatch(/^PRJ-\d{4}-\d{4}$/);
      expect(project.statusChangedAt).not.toBeNull();
      expect(project.services.map((s) => s.name).sort()).toEqual(['Audit', 'Inspection']);

      const [created] = await auditOf('Project', project.id);
      expect(created).toMatchObject({ action: 'CREATE', source: 'web', actorId: sales.user.id });
      const request = await sameRequest(created!);
      expect(request.filter((r) => r.entityType === 'Project')).toHaveLength(1);
      expect(request.filter((r) => r.entityType === 'ProjectService').map((r) => r.action)).toEqual(
        ['CREATE', 'CREATE'],
      );
    });

    it('lets an admin create a project, and leaves the manager unassigned when omitted', async () => {
      const { quotation } = await wonQuotation(w);
      const project = await createProject(
        admin,
        projectInput(w, quotation.id, { managerId: undefined }),
      );
      expect(project.managerId).toBeNull();
      expect(project.quotation.ownerId).toBe(sales.user.id);
    });

    it('is forbidden for project managers, and not found for another rep’s quotation', async () => {
      const { quotation } = await wonQuotation(w);
      expect(await rejection(createProject(pm, projectInput(w, quotation.id)))).toBeInstanceOf(
        ForbiddenError,
      );
      expect(await rejection(createProject(sales2, projectInput(w, quotation.id)))).toBeInstanceOf(
        NotFoundError,
      );
    });

    it('offers active project managers only', async () => {
      const options = await listProjectManagerOptions(sales);
      expect(options.map((o) => o.id).sort()).toEqual([pm.user.id, pm2.user.id].sort());
      expect(await rejection(listProjectManagerOptions(pm))).toBeInstanceOf(ForbiddenError);
    });
  });

  describe('AC2: validation', () => {
    it('rejects a missing quotation as not found, and an open or lost one on quotationId', async () => {
      expect(await rejection(createProject(sales, projectInput(w, 'nope')))).toBeInstanceOf(
        NotFoundError,
      );
      const { quotation } = await wonQuotation(w);
      // Build open and lost quotations on the same converted enquiry.
      const { createQuotation } = await import('../services/quotation.service.ts');
      const base = {
        enquiryId: quotation.enquiryId,
        quotationDate: '2026-03-12',
        amount: '10',
        currency: 'INR',
        sectorId: w.pharma,
        serviceIds: [w.inspection],
        nextFollowUpDate: '2026-03-20',
      };
      const open = await createQuotation(sales, base);
      const lost = await createQuotation(sales, base);
      await changeQuotationStatus(sales, { id: lost.id, to: 'LOST', lostReason: 'Price' });
      for (const id of [open.id, lost.id]) {
        expect(fieldOf(await rejection(createProject(sales, projectInput(w, id))))).toBe(
          'quotationId',
        );
      }
    });

    it('rejects a quotation that already has a live project', async () => {
      const { quotation, project } = await newProject(w);
      const error = await rejection(createProject(sales, projectInput(w, quotation.id)));
      expect(fieldOf(error)).toBe('quotationId');
      expect((error as DomainError).message).toContain(project.number);
    });

    it('rejects a manager who is not an active project manager', async () => {
      const gonePm = (await createTestUser('gone-pm@example.test', 'PROJECT_MANAGER')).id;
      await deactivateUser(admin, gonePm);
      for (const managerId of [sales.user.id, admin.user.id, gonePm, 'nope']) {
        const { quotation } = await wonQuotation(w);
        expect(
          fieldOf(
            await rejection(createProject(sales, projectInput(w, quotation.id, { managerId }))),
          ),
        ).toBe('managerId');
      }
    });

    it('rejects bad services, currency, revenue and dates', async () => {
      const retired = (await import('../services/service.service.ts')).createService;
      const oldService = (await retired(admin, { name: 'Retired' })).id;
      await updateService(admin, oldService, { active: false });
      const cases: [Partial<Parameters<typeof projectInput>[2]>, string][] = [
        [{ serviceIds: [] }, 'serviceIds'],
        [{ serviceIds: [w.inspection, w.inspection] }, 'serviceIds'],
        [{ serviceIds: [w.inspection, oldService] }, 'serviceIds'],
        [{ currency: 'EUR', revenue: '10' }, 'currency'],
        [{ revenue: '-1' }, 'revenue'],
        [{ revenue: '10.123' }, 'revenue'],
        [{ startDate: '2026-05-10', endDate: '2026-05-01' }, 'endDate'],
      ];
      for (const [overrides, field] of cases) {
        const { quotation } = await wonQuotation(w);
        const error = await rejection(
          createProject(sales, projectInput(w, quotation.id, overrides)),
        );
        const zodField = (error as { issues?: { path: (string | number)[] }[] }).issues?.[0]
          ?.path[0];
        expect(fieldOf(error) ?? zodField).toBe(field);
      }
    });

    it('rejects client, status, number and closing fields in the input', async () => {
      const { quotation, project } = await newProject(w);
      for (const extra of [
        { clientId: w.acme },
        { status: 'IN_PROGRESS' },
        { number: 'PRJ-1' },
        { completionPct: 10 },
        { completedDate: '2026-05-01' },
        { holdReason: 'x' },
        { cancelReason: 'x' },
      ]) {
        const { quotation: q2 } = await wonQuotation(w);
        await expect(
          createProject(sales, { ...projectInput(w, q2.id), ...extra } as never),
        ).rejects.toThrow();
      }
      for (const extra of [
        { clientId: w.acme },
        { status: 'IN_PROGRESS' },
        { quotationId: quotation.id },
        { completedDate: '2026-05-01' },
        { holdReason: 'x' },
        { cancelReason: 'x' },
      ]) {
        await expect(updateProject(admin, project.id, extra as never)).rejects.toThrow();
      }
    });
  });

  describe('AC3: field rules', () => {
    it('lets the assigned PM change delivery fields, and not commercial ones', async () => {
      const { project } = await newProject(w);
      const updated = await updateProject(pm, project.id, {
        name: 'Renamed',
        startDate: '2026-04-10',
        endDate: FAR_FUTURE,
        completionPct: 30,
        description: 'Going well',
      });
      expect(updated).toMatchObject({
        name: 'Renamed',
        completionPct: 30,
        description: 'Going well',
      });
      for (const [field, value] of [
        ['managerId', pm2.user.id],
        ['serviceIds', [w.audit]],
      ] as const) {
        expect(fieldOf(await rejection(updateProject(pm, project.id, { [field]: value })))).toBe(
          field,
        );
      }
      expect(
        fieldOf(await rejection(updateProject(pm, project.id, { revenue: '1', currency: 'INR' }))),
      ).toBe('revenue');
    });

    it('lets an admin change every field, diffing services', async () => {
      const { project } = await newProject(w);
      const updated = await updateProject(admin, project.id, {
        managerId: pm2.user.id,
        serviceIds: [w.audit, w.certification],
        revenue: '99.99',
        currency: 'USD',
      });
      expect(updated).toMatchObject({
        managerId: pm2.user.id,
        revenueMinor: 9999n,
        currency: 'USD',
      });
      expect(updated.services.map((s) => s.name).sort()).toEqual(['Audit', 'Certification']);
      const links = await getDb().auditLog.findMany({
        where: {
          entityType: 'ProjectService',
          requestId: (await auditOf('Project', project.id)).at(-1)!.requestId!,
        },
      });
      expect(links.map((r) => r.action).sort()).toEqual(['CREATE', 'DELETE']);
      const update = (await auditOf('Project', project.id)).at(-1)!;
      expect(update).toMatchObject({ action: 'UPDATE', actorId: admin.user.id });
      expect(update.changedFields).toEqual(
        expect.arrayContaining(['managerId', 'revenueMinor', 'currency']),
      );
    });

    it('keeps a closed project to description only, and a started one to a start date', async () => {
      const { project } = await newProject(w);
      await start(project.id);
      expect(fieldOf(await rejection(updateProject(pm, project.id, { startDate: '' })))).toBe(
        'startDate',
      );
      await changeProjectStatus(pm, {
        id: project.id,
        to: 'COMPLETED',
        completedDate: '2026-05-01',
      });
      expect(
        fieldOf(await rejection(updateProject(admin, project.id, { completionPct: 50 }))),
      ).toBe('completionPct');
      expect((await updateProject(pm, project.id, { description: 'Done' })).description).toBe(
        'Done',
      );

      const { project: cancelled } = await newProject(w);
      await changeProjectStatus(admin, {
        id: cancelled.id,
        to: 'CANCELLED',
        cancelReason: 'Client withdrew',
      });
      expect(fieldOf(await rejection(updateProject(admin, cancelled.id, { name: 'x' })))).toBe(
        'name',
      );
      expect((await updateProject(admin, cancelled.id, { description: 'Why' })).description).toBe(
        'Why',
      );
    });

    it('rejects a planned start in the future once started, and an end before the start', async () => {
      const { project } = await newProject(w);
      // Planned start in the future is fine while NOT_STARTED.
      await updateProject(pm, project.id, { startDate: FAR_FUTURE });
      expect(
        fieldOf(await rejection(changeProjectStatus(pm, { id: project.id, to: 'IN_PROGRESS' }))),
      ).toBe('startDate');
      await start(project.id);
      expect(
        fieldOf(await rejection(updateProject(pm, project.id, { startDate: FAR_FUTURE }))),
      ).toBe('startDate');
      expect(
        fieldOf(await rejection(updateProject(pm, project.id, { endDate: '2026-04-01' }))),
      ).toBe('endDate');
    });
  });

  describe('AC4: RBAC (the "done when")', () => {
    it('lists only assigned projects for a PM, own-quotation projects for Sales, all for admins', async () => {
      const { project: mine } = await newProject(w);
      const { project: other } = await newProject(w, { managerId: pm2.user.id }, sales2);
      const { project: unassigned } = await newProject(w, { managerId: '' });
      const ids = async (ctx: Ctx) =>
        (await listProjects(ctx, { pageSize: 100 })).items.map((p) => p.id);

      const pmIds = await ids(pm);
      expect(pmIds).toContain(mine.id);
      expect(pmIds).not.toContain(other.id);
      expect(pmIds).not.toContain(unassigned.id);
      expect(
        (await listProjects(pm, { pageSize: 100 })).items.every((p) => p.managerId === pm.user.id),
      ).toBe(true);

      expect(await ids(sales)).toEqual(expect.arrayContaining([mine.id, unassigned.id]));
      expect(await ids(sales)).not.toContain(other.id);
      expect(await ids(admin)).toEqual(expect.arrayContaining([mine.id, other.id, unassigned.id]));

      expect(scopeProjects(pm.user)).toEqual({ managerId: pm.user.id });
      expect(projectResource({ managerId: 'm', quotation: { ownerId: 'o' } })).toEqual({
        type: 'project',
        managerId: 'm',
        quotationOwnerId: 'o',
      });
    });

    it('hides another PM’s or an unassigned project from a PM (not found)', async () => {
      const { project: other } = await newProject(w, { managerId: pm2.user.id });
      const { project: unassigned } = await newProject(w, { managerId: '' });
      for (const id of [other.id, unassigned.id]) {
        expect(await rejection(getProject(pm, id))).toBeInstanceOf(NotFoundError);
        expect(await rejection(updateProject(pm, id, { completionPct: 5 }))).toBeInstanceOf(
          NotFoundError,
        );
        expect(await rejection(start(id))).toBeInstanceOf(NotFoundError);
      }
    });

    it('moves a project between PMs on reassignment', async () => {
      const { project } = await newProject(w);
      await updateProject(admin, project.id, { managerId: pm2.user.id });
      expect(await rejection(getProject(pm, project.id))).toBeInstanceOf(NotFoundError);
      expect((await getProject(pm2, project.id)).id).toBe(project.id);
    });

    it('forbids PMs from deleting, and Sales from changing, even their own project', async () => {
      const { project } = await newProject(w);
      expect(await rejection(softDeleteProject(pm, project.id))).toBeInstanceOf(ForbiddenError);
      expect(await rejection(updateProject(sales, project.id, { name: 'x' }))).toBeInstanceOf(
        ForbiddenError,
      );
      expect(await rejection(start(project.id, sales))).toBeInstanceOf(ForbiddenError);
      expect(await rejection(softDeleteProject(sales, project.id))).toBeInstanceOf(ForbiddenError);
      expect((await getProject(sales, project.id)).permissions).toMatchObject({
        canUpdate: false,
        canChangeStatus: false,
        canDelete: false,
      });
      expect((await getProject(pm, project.id)).permissions).toMatchObject({
        canUpdate: true,
        canChangeStatus: true,
        canCancel: false,
        canReassign: false,
        canDelete: false,
      });
    });

    it('moves Sales visibility with the quotation owner', async () => {
      const { quotation, project } = await newProject(w);
      await updateQuotation(admin, quotation.id, { ownerId: sales2.user.id });
      expect(await rejection(getProject(sales, project.id))).toBeInstanceOf(NotFoundError);
      expect((await getProject(sales2, project.id)).quotation.ownerId).toBe(sales2.user.id);
    });

    it('lists by quotation and by client within scope', async () => {
      const { quotation, project } = await newProject(w);
      expect((await listProjectsForQuotation(sales, quotation.id)).map((p) => p.id)).toEqual([
        project.id,
      ]);
      expect((await listProjectsForClient(pm2, w.acme)).map((p) => p.id)).not.toContain(project.id);
      expect((await listProjectsForClient(pm, w.acme)).map((p) => p.id)).toContain(project.id);
    });
  });

  describe('AC7: status changes', () => {
    it('writes one audited UPDATE per move; completing sets 100% and the date', async () => {
      const { project } = await newProject(w);
      await start(project.id);
      await changeProjectStatus(pm, { id: project.id, to: 'ON_HOLD', holdReason: 'Site closed' });
      await changeProjectStatus(pm, { id: project.id, to: 'IN_PROGRESS' });
      const done = await changeProjectStatus(pm, {
        id: project.id,
        to: 'COMPLETED',
        completedDate: '2026-05-01',
      });
      expect(done).toMatchObject({
        status: 'COMPLETED',
        completionPct: 100,
        holdReason: 'Site closed',
      });
      expect(toCalendarDateString(done.completedDate!)).toBe('2026-05-01');

      const updates = (await auditOf('Project', project.id)).filter((r) => r.action === 'UPDATE');
      expect(updates).toHaveLength(4);
      for (const row of updates) {
        expect(row.changedFields).toEqual(expect.arrayContaining(['status', 'statusChangedAt']));
      }
      expect(updates.at(-1)!.changedFields).toEqual(
        expect.arrayContaining(['completionPct', 'completedDate']),
      );
    });

    it('rejects status in updateProject', async () => {
      const { project } = await newProject(w);
      await expect(
        updateProject(admin, project.id, { status: 'IN_PROGRESS' } as never),
      ).rejects.toThrow();
      expect((await getProject(admin, project.id)).status).toBe('NOT_STARTED');
    });

    it('lets only admins cancel; a cancelled project is terminal and keeps its progress', async () => {
      const { project } = await newProject(w);
      await start(project.id);
      await updateProject(pm, project.id, { completionPct: 40, endDate: '2026-04-30' });
      for (const ctx of [pm, sales]) {
        const error = await rejection(
          changeProjectStatus(ctx, { id: project.id, to: 'CANCELLED', cancelReason: 'x' }),
        );
        expect(error).toBeInstanceOf(ForbiddenError);
        // PMs may update the project; cancelling is a separate admin-only check.
        expect((error as Error).message).toBe(
          ctx === pm ? 'Not allowed to cancel project' : 'Not allowed to update project',
        );
      }
      const cancelled = await changeProjectStatus(admin, {
        id: project.id,
        to: 'CANCELLED',
        cancelReason: 'Client withdrew',
      });
      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        completionPct: 40,
        cancelReason: 'Client withdrew',
        behindSchedule: false,
      });
      const last = (await auditOf('Project', project.id)).at(-1)!;
      expect(last).toMatchObject({ action: 'UPDATE', actorId: admin.user.id });
      for (const to of ['IN_PROGRESS', 'ON_HOLD', 'COMPLETED'] as const) {
        await expect(
          changeProjectStatus(admin, {
            id: project.id,
            to,
            holdReason: 'x',
            completedDate: '2026-05-01',
          } as never),
        ).rejects.toThrow(DomainError);
      }
      const behind = await listProjects(admin, { behindSchedule: true, pageSize: 100 });
      expect(behind.items.map((p) => p.id)).not.toContain(project.id);
      // Still the quotation's project.
      await expect(createProject(sales, projectInput(w, project.quotationId))).rejects.toThrow(
        DomainError,
      );
    });
  });

  describe('AC8: quotation link', () => {
    it('blocks a second project until the first is deleted, then blocks restoring the first', async () => {
      const { quotation, project } = await newProject(w);
      expect(await rejection(getProjectDraft(sales, quotation.id))).toBeInstanceOf(DomainError);
      expect((await getQuotation(sales, quotation.id)).projects).toEqual([
        expect.objectContaining({ id: project.id, number: project.number }),
      ]);

      await softDeleteProject(admin, project.id);
      expect((await getQuotation(sales, quotation.id)).projects).toEqual([]);
      expect((await getProjectDraft(sales, quotation.id)).quotationId).toBe(quotation.id);
      const replacement = await createProject(sales, projectInput(w, quotation.id));
      expect(fieldOf(await rejection(restoreProject(admin, project.id)))).toBe('quotationId');
      expect((await getQuotation(sales, quotation.id)).projects[0]!.id).toBe(replacement.id);
    });

    it('lists PO_RECEIVED quotations with and without a project', async () => {
      const { quotation: waiting } = await wonQuotation(w);
      const { quotation: taken } = await newProject(w);
      const without = await listQuotations(sales, {
        status: ['PO_RECEIVED'],
        hasProject: false,
        pageSize: 100,
      });
      expect(without.items.map((q) => q.id)).toContain(waiting.id);
      expect(without.items.map((q) => q.id)).not.toContain(taken.id);
      const withProject = await listQuotations(sales, { hasProject: 'true', pageSize: 100 });
      expect(withProject.items.map((q) => q.id)).toContain(taken.id);
    });
  });

  describe('AC10: soft delete', () => {
    it('lets admins delete and restore; a deleted project leaves lists and its PM’s reach', async () => {
      const { enquiry, quotation, project } = await newProject(w);
      expect((await getQuotation(pm, quotation.id)).id).toBe(quotation.id);

      await softDeleteProject(admin, project.id);
      const rows = await auditOf('Project', project.id);
      expect(rows.at(-1)!.action).toBe('SOFT_DELETE');
      expect((await listProjects(admin, { pageSize: 100 })).items.map((p) => p.id)).not.toContain(
        project.id,
      );
      expect(
        (await listProjects(admin, { recordStatus: 'deleted', pageSize: 100 })).items.map(
          (p) => p.id,
        ),
      ).toContain(project.id);
      expect(await rejection(getQuotation(pm, quotation.id))).toBeInstanceOf(NotFoundError);
      const { getEnquiry } = await import('../services/enquiry.service.ts');
      expect(await rejection(getEnquiry(pm, enquiry.id))).toBeInstanceOf(NotFoundError);

      await restoreProject(admin, project.id);
      expect((await auditOf('Project', project.id)).at(-1)!.action).toBe('RESTORE');
      expect((await getQuotation(pm, quotation.id)).id).toBe(quotation.id);
    });
  });

  describe('AC11: list', () => {
    it('filters, searches and sorts within scope', async () => {
      const { quotation, project: a } = await newProject(w, {
        name: 'Zeta line audit',
        endDate: '2026-04-30',
        startDate: '2026-04-01',
      });
      await start(a.id);
      const { project: b } = await newProject(w, {
        managerId: '',
        serviceIds: [w.certification],
        revenue: '5',
        currency: 'USD',
        startDate: '2026-06-01',
        endDate: FAR_FUTURE,
      });
      const ids = async (input: Parameters<typeof listProjects>[1], ctx: Ctx = admin) =>
        (await listProjects(ctx, { pageSize: 100, ...input })).items.map((p) => p.id);

      expect(await ids({ status: ['IN_PROGRESS'] })).toContain(a.id);
      expect(await ids({ status: ['IN_PROGRESS'] })).not.toContain(b.id);
      expect(await ids({ managerId: 'none' })).toContain(b.id);
      expect(await ids({ managerId: 'none' })).not.toContain(a.id);
      expect(await ids({ managerId: pm.user.id })).toContain(a.id);
      expect(await ids({ ownerId: sales.user.id })).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(await ids({ clientId: w.acme })).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(await ids({ serviceId: w.certification })).toContain(b.id);
      expect(await ids({ serviceId: w.certification })).not.toContain(a.id);
      expect(await ids({ quotationId: quotation.id })).toEqual([a.id]);
      expect(await ids({ currency: ['USD'] })).toContain(b.id);
      expect(await ids({ currency: ['USD'] })).not.toContain(a.id);
      expect(await ids({ startFrom: '2026-05-15', startTo: '2026-06-15' })).toContain(b.id);
      expect(await ids({ endFrom: '2026-04-01', endTo: '2026-05-01' })).toContain(a.id);
      expect(await ids({ endFrom: '2026-04-01', endTo: '2026-05-01' })).not.toContain(b.id);
      expect(await ids({ behindSchedule: true })).toContain(a.id);
      expect(await ids({ behindSchedule: true })).not.toContain(b.id);
      expect(await ids({ q: 'zeta line' })).toEqual([a.id]);
      expect(await ids({ q: a.number })).toEqual([a.id]);
      expect(await ids({ q: quotation.number })).toEqual([a.id]);
      expect(await ids({ q: 'acme pharma' })).toEqual(expect.arrayContaining([a.id, b.id]));
      // Scope still applies.
      expect(await ids({ managerId: 'none' }, pm)).toEqual([]);

      const page = await listProjects(admin, { sort: 'number', dir: 'asc', pageSize: 1, page: 2 });
      const all = await listProjects(admin, { sort: 'number', dir: 'asc', pageSize: 100 });
      expect(page.items.map((p) => p.number)).toEqual([all.items[1]!.number]);
      expect(page.total).toBe(all.total);
      expect(all.items.map((p) => p.number)).toEqual(all.items.map((p) => p.number).sort());
      const rows = (await listProjects(admin, { pageSize: 100 })).items;
      expect(rows.find((p) => p.id === a.id)!.behindSchedule).toBe(true);
    });

    it('rejects the owner filter for non-admins', async () => {
      expect(fieldOf(await rejection(listProjects(sales, { ownerId: sales2.user.id })))).toBe(
        'ownerId',
      );
    });

    it('uses today in Asia/Kolkata for behind schedule', () => {
      // 20:00 UTC on 26 Sep is 01:30 IST on 27 Sep.
      expect(toCalendarDateString(todayInIST(new Date('2026-09-26T20:00:00Z')))).toBe('2026-09-27');
    });
  });

  describe('AC12: numbering', () => {
    it('numbers projects independently, and a failed create does not use a number', async () => {
      const { project: first } = await newProject(w);
      const { quotation } = await wonQuotation(w);
      await expect(
        createProject(sales, projectInput(w, quotation.id, { managerId: sales.user.id })),
      ).rejects.toThrow();
      const second = await createProject(sales, projectInput(w, quotation.id));
      const seq = (n: string) => Number(n.slice(-4));
      expect(seq(second.number)).toBe(seq(first.number) + 1);
      expect(first.number.slice(4, 8)).toBe(String(todayInIST().getUTCFullYear()));

      await softDeleteProject(admin, second.id);
      expect((await getProject(admin, second.id)).number).toBe(second.number);
    });
  });

  describe('search and summary', () => {
    it('finds projects by number, name and client in ⌘K, scoped like the list', async () => {
      const { project } = await newProject(w, { name: 'Quartz kiln survey' });
      const types = async (ctx: Ctx, q: string) =>
        (await searchRecords(ctx, { q, limit: 10 }))
          .filter((r) => r.type === 'PROJECT')
          .map((r) => r.id);
      expect(await types(pm, 'quartz kiln')).toEqual([project.id]);
      expect(await types(sales, project.number)).toEqual([project.id]);
      expect(await types(pm2, 'quartz kiln')).toEqual([]);
      expect(await types(sales2, 'quartz kiln')).toEqual([]);
      const [hit] = await searchRecords(admin, { q: 'quartz kiln' });
      expect(hit).toMatchObject({
        type: 'PROJECT',
        label: project.number,
        detail: 'Quartz kiln survey',
      });
    });

    it('counts statuses and behind-schedule projects within scope', async () => {
      const before = await projectStatusCounts(pm2);
      const { project } = await newProject(w, { managerId: pm2.user.id, endDate: '2026-04-30' });
      await start(project.id, pm2);
      const after = await projectStatusCounts(pm2);
      expect(after.IN_PROGRESS).toBe(before.IN_PROGRESS + 1);
      expect(after.behindSchedule).toBe(before.behindSchedule + 1);
      const all = await projectStatusCounts(admin);
      expect(all.IN_PROGRESS).toBeGreaterThanOrEqual(after.IN_PROGRESS);
      expect(Object.keys(all).sort()).toEqual(
        [
          'CANCELLED',
          'COMPLETED',
          'IN_PROGRESS',
          'NOT_STARTED',
          'ON_HOLD',
          'behindSchedule',
        ].sort(),
      );
    });
  });
});
