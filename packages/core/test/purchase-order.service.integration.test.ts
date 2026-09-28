import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import {
  changeProjectStatus,
  getProject,
  softDeleteProject,
  updateProject,
} from '../services/project.service.ts';
import {
  createPurchaseOrder,
  getPurchaseOrder,
  getPurchaseOrderDraft,
  listPurchaseOrders,
  listPurchaseOrdersForClient,
  listPurchaseOrdersForProject,
  restorePurchaseOrder,
  softDeletePurchaseOrder,
  updatePurchaseOrder,
} from '../services/purchase-order.service.ts';
import { getQuotation, updateQuotation } from '../services/quotation.service.ts';
import { searchRecords } from '../services/search.service.ts';
import { updateSettings } from '../services/settings.service.ts';
import { auditOf, fieldOf, newProject, rejection, sameRequest } from './project-fixtures.ts';
import {
  newPurchaseOrder,
  poInput,
  poWorld,
  uniquePoNumber,
  type PoWorld,
} from './purchase-order-fixtures.ts';

const today = () => toCalendarDateString(todayInIST());
const tomorrow = () => toCalendarDateString(new Date(todayInIST().getTime() + 86_400_000));

describe('purchase orders (integration)', () => {
  let w: PoWorld;
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let pm: Ctx;
  let pm2: Ctx;

  beforeAll(async () => {
    w = await poWorld();
    ({ admin, sales, sales2, pm, pm2 } = w);
  });
  afterAll(disconnectAll);

  const ids = async (ctx: Ctx, input: Parameters<typeof listPurchaseOrders>[1] = {}) =>
    (await listPurchaseOrders(ctx, { pageSize: 100, ...input })).items.map((po) => po.id);

  describe('AC1: create', () => {
    it('creates a PENDING PO on the project, with its client, services and audit rows', async () => {
      const { project } = await newProject(w);
      const { purchaseOrder, coverage } = await createPurchaseOrder(
        sales,
        poInput(w, project.id, {
          poNumber: '  4500012345 ',
          amount: '1,00,000.25',
          paymentTerms: 'Net 45',
          paymentTermsDays: 45,
          description: 'Main order',
        }),
      );

      expect(purchaseOrder).toMatchObject({
        status: 'PENDING',
        projectId: project.id,
        clientId: w.acme,
        poNumber: '4500012345',
        amountMinor: 10_000_025n,
        currency: 'INR',
        paymentTerms: 'Net 45',
        paymentTermsDays: 45,
        description: 'Main order',
        documentId: null,
        client: { id: w.acme, name: 'Acme Pharma' },
        project: { id: project.id, number: project.number },
      });
      expect(purchaseOrder.statusChangedAt).toBeInstanceOf(Date);
      expect(toCalendarDateString(purchaseOrder.receivedDate)).toBe('2026-04-02');
      expect(purchaseOrder.services.map((s) => s.id).sort()).toEqual(
        [w.inspection, w.audit].sort(),
      );
      expect(coverage).toMatchObject({ overCovered: false, warning: null });

      const [created] = await auditOf('PurchaseOrder', purchaseOrder.id);
      expect(created).toMatchObject({ action: 'CREATE', source: 'web', actorId: sales.user.id });
      const batch = await sameRequest(created!);
      expect(batch.filter((r) => r.entityType === 'PurchaseOrderService')).toHaveLength(2);
      expect(
        batch.every(
          (r) => r.action === 'CREATE' && r.source === 'web' && r.actorId === sales.user.id,
        ),
      ).toBe(true);
    });

    it('the project’s PM and admins can create; the PO is on the pipeline owner’s list', async () => {
      const { project } = await newProject(w);
      const { purchaseOrder: byPm } = await createPurchaseOrder(pm, poInput(w, project.id));
      const { purchaseOrder: byAdmin } = await createPurchaseOrder(admin, poInput(w, project.id));
      expect(await ids(sales, { projectId: project.id })).toEqual(
        expect.arrayContaining([byPm.id, byAdmin.id]),
      );
    });

    it('warns, without blocking, when POs in the project currency exceed its revenue', async () => {
      const { project } = await newProject(w); // revenue ₹1,25,000.50
      await createPurchaseOrder(sales, poInput(w, project.id, { amount: '1,00,000' }));
      const { coverage } = await createPurchaseOrder(
        sales,
        poInput(w, project.id, { amount: '50,000' }),
      );
      expect(coverage).toMatchObject({
        currency: 'INR',
        coveredMinor: 1_50_000_00n,
        revenueMinor: 12_500_050n,
        overCovered: true,
      });
      expect(coverage.warning).toMatch(/₹1,50,000\.00.*₹1,25,000\.50/);
    });
  });

  describe('AC2: validation against the database', () => {
    it('rejects a PO number a live PO of the same client has, ignoring case and spaces', async () => {
      const number = uniquePoNumber();
      const { project, purchaseOrder } = await newPurchaseOrder(w, { poNumber: number });
      const other = await newProject(w);
      for (const clash of [number, number.toLowerCase(), `  ${number.toUpperCase()}  `]) {
        const error = await rejection(
          createPurchaseOrder(sales, poInput(w, other.project.id, { poNumber: clash })),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect(fieldOf(error)).toBe('poNumber');
        expect((error as Error).message).toContain(project.number);
      }
      // Another client may use the same number.
      const globexProject = await newProject(w, {}, sales, w.globex);
      await createPurchaseOrder(sales, poInput(w, globexProject.project.id, { poNumber: number }));
      // The same client may reuse it once the earlier PO is deleted.
      await softDeletePurchaseOrder(sales, purchaseOrder.id);
      await createPurchaseOrder(sales, poInput(w, other.project.id, { poNumber: number }));
    });

    it('rejects a future received date', async () => {
      const { project } = await newProject(w);
      const error = await rejection(
        createPurchaseOrder(sales, poInput(w, project.id, { receivedDate: tomorrow() })),
      );
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues.map((i) => i.path[0])).toContain('receivedDate');
      await createPurchaseOrder(sales, poInput(w, project.id, { receivedDate: today() }));
    });

    it('rejects a disabled currency unless it is the project’s own', async () => {
      const { project } = await newProject(w);
      expect(
        fieldOf(
          await rejection(createPurchaseOrder(sales, poInput(w, project.id, { currency: 'EUR' }))),
        ),
      ).toBe('currency');
      // USD is enabled in the world; a USD project keeps taking USD POs after it is disabled.
      const usd = await newProject(w, { revenue: '5,000', currency: 'USD' });
      await updateSettings(admin, {
        companyName: 'Test Co',
        defaultInvoiceDueDays: 30,
        enabledCurrencies: ['INR'],
      });
      try {
        await createPurchaseOrder(
          sales,
          poInput(w, usd.project.id, { amount: '5,000', currency: 'USD' }),
        );
        expect(
          fieldOf(
            await rejection(
              createPurchaseOrder(sales, poInput(w, project.id, { currency: 'USD' })),
            ),
          ),
        ).toBe('currency');
      } finally {
        await updateSettings(admin, {
          companyName: 'Test Co',
          defaultInvoiceDueDays: 30,
          enabledCurrencies: ['INR', 'USD'],
        });
      }
    });

    it('rejects a service that is not on the project', async () => {
      const { project } = await newProject(w);
      const error = await rejection(
        createPurchaseOrder(sales, poInput(w, project.id, { serviceIds: [w.certification] })),
      );
      expect(fieldOf(error)).toBe('serviceIds');
      await createPurchaseOrder(sales, poInput(w, project.id, { serviceIds: [w.audit] }));
    });

    it('rejects a cancelled, deleted or unreadable project', async () => {
      const cancelled = await newProject(w);
      await changeProjectStatus(admin, {
        id: cancelled.project.id,
        to: 'CANCELLED',
        cancelReason: 'Client withdrew',
      });
      const error = await rejection(createPurchaseOrder(sales, poInput(w, cancelled.project.id)));
      expect(error).toBeInstanceOf(DomainError);
      expect(fieldOf(error)).toBe('projectId');
      expect((error as Error).message).toBe('A cancelled project takes no new purchase orders');

      const deleted = await newProject(w);
      await softDeleteProject(admin, deleted.project.id);
      await expect(createPurchaseOrder(sales, poInput(w, deleted.project.id))).rejects.toThrow(
        NotFoundError,
      );

      const others = await newProject(w);
      await expect(createPurchaseOrder(sales2, poInput(w, others.project.id))).rejects.toThrow(
        NotFoundError,
      );
      await expect(createPurchaseOrder(pm2, poInput(w, others.project.id))).rejects.toThrow(
        NotFoundError,
      );
      await expect(createPurchaseOrder(sales, poInput(w, 'no-such-project'))).rejects.toThrow(
        NotFoundError,
      );
    });

    it('rejects clientId, status and documentId in create input, and projectId in update', async () => {
      const { project, purchaseOrder } = await newPurchaseOrder(w);
      for (const extra of [{ clientId: w.globex }, { status: 'PAID' }, { documentId: 'd1' }]) {
        await expect(
          createPurchaseOrder(sales, { ...poInput(w, project.id), ...extra } as never),
        ).rejects.toThrow();
      }
      const other = await newProject(w);
      for (const extra of [
        { clientId: w.globex },
        { status: 'PAID' },
        { documentId: 'd1' },
        { projectId: other.project.id },
      ]) {
        await expect(
          updatePurchaseOrder(sales, purchaseOrder.id, { description: 'x', ...extra } as never),
        ).rejects.toThrow();
      }
      const after = await getPurchaseOrder(sales, purchaseOrder.id);
      expect(after).toMatchObject({ projectId: project.id, clientId: w.acme, status: 'PENDING' });
      expect(after.description).toBeNull();
    });
  });

  describe('AC3: RBAC', () => {
    it('lists POs by project manager, pipeline owner, or everything for admins', async () => {
      const mine = await newPurchaseOrder(w);
      const pm2s = await newPurchaseOrder(w, {}, { projectOverrides: { managerId: pm2.user.id } });
      const sales2s = await newPurchaseOrder(w, {}, { owner: sales2 });

      const pmIds = await ids(pm);
      expect(pmIds).toContain(mine.purchaseOrder.id);
      expect(pmIds).toContain(sales2s.purchaseOrder.id); // managed by pm, owned by sales2
      expect(pmIds).not.toContain(pm2s.purchaseOrder.id);

      const salesIds = await ids(sales);
      expect(salesIds).toContain(mine.purchaseOrder.id);
      expect(salesIds).toContain(pm2s.purchaseOrder.id);
      expect(salesIds).not.toContain(sales2s.purchaseOrder.id);

      expect(await ids(admin)).toEqual(
        expect.arrayContaining([mine, pm2s, sales2s].map((x) => x.purchaseOrder.id)),
      );
    });

    it('another PM or Sales rep gets not found for the PO and its related lists', async () => {
      const { project, purchaseOrder } = await newPurchaseOrder(w);
      for (const ctx of [pm2, sales2]) {
        await expect(getPurchaseOrder(ctx, purchaseOrder.id)).rejects.toThrow(NotFoundError);
        await expect(
          updatePurchaseOrder(ctx, purchaseOrder.id, { description: 'x' }),
        ).rejects.toThrow(NotFoundError);
        await expect(softDeletePurchaseOrder(ctx, purchaseOrder.id)).rejects.toThrow(NotFoundError);
        await expect(getPurchaseOrderDraft(ctx, project.id)).rejects.toThrow(NotFoundError);
        expect(await listPurchaseOrdersForProject(ctx, project.id)).toEqual([]);
        expect((await listPurchaseOrdersForClient(ctx, w.acme)).map((p) => p.id)).not.toContain(
          purchaseOrder.id,
        );
      }
    });

    it('the PM and the pipeline owner can update, delete and restore, each audited', async () => {
      for (const ctx of [pm, sales]) {
        const { purchaseOrder } = await newPurchaseOrder(w);
        const updated = await updatePurchaseOrder(ctx, purchaseOrder.id, {
          description: 'Revised scope',
          paymentTerms: 'Net 30',
          paymentTermsDays: 30,
        });
        expect(updated).toMatchObject({ description: 'Revised scope', paymentTermsDays: 30 });
        await softDeletePurchaseOrder(ctx, purchaseOrder.id);
        await restorePurchaseOrder(ctx, purchaseOrder.id);
        const actions = (await auditOf('PurchaseOrder', purchaseOrder.id)).map((r) => [
          r.action,
          r.actorId,
          r.source,
        ]);
        expect(actions.slice(1)).toEqual([
          ['UPDATE', ctx.user.id, 'web'],
          ['SOFT_DELETE', ctx.user.id, 'web'],
          ['RESTORE', ctx.user.id, 'web'],
        ]);
        const [update] = (await auditOf('PurchaseOrder', purchaseOrder.id)).filter(
          (r) => r.action === 'UPDATE',
        );
        expect(update!.changedFields.sort()).toEqual(
          ['description', 'paymentTerms', 'paymentTermsDays'].sort(),
        );
      }
    });

    it('on an unassigned project only the Sales owner and admins can work with POs', async () => {
      const { project } = await newProject(w, { managerId: '' });
      const { purchaseOrder } = await createPurchaseOrder(sales, poInput(w, project.id));
      await createPurchaseOrder(admin, poInput(w, project.id));
      for (const ctx of [pm, pm2]) {
        await expect(createPurchaseOrder(ctx, poInput(w, project.id))).rejects.toThrow(
          NotFoundError,
        );
        await expect(getPurchaseOrder(ctx, purchaseOrder.id)).rejects.toThrow(NotFoundError);
      }
      expect(await ids(sales, { managerId: 'none' })).toContain(purchaseOrder.id);
    });

    it('rejects a non-admin filtering by owner', async () => {
      const error = await rejection(listPurchaseOrders(sales, { ownerId: sales2.user.id }));
      expect(fieldOf(error)).toBe('ownerId');
    });

    it('reassigning the project or the quotation moves the PO between lists', async () => {
      const { quotation, project, purchaseOrder } = await newPurchaseOrder(w);
      await updateProject(admin, project.id, { managerId: pm2.user.id });
      expect(await ids(pm)).not.toContain(purchaseOrder.id);
      expect(await ids(pm2)).toContain(purchaseOrder.id);
      await expect(getPurchaseOrder(pm, purchaseOrder.id)).rejects.toThrow(NotFoundError);
      await updatePurchaseOrder(pm2, purchaseOrder.id, { description: 'Now mine' });

      await updateQuotation(admin, quotation.id, { ownerId: sales2.user.id });
      expect(await ids(sales)).not.toContain(purchaseOrder.id);
      expect(await ids(sales2)).toContain(purchaseOrder.id);
      await expect(softDeletePurchaseOrder(sales, purchaseOrder.id)).rejects.toThrow(NotFoundError);
    });

    it('an inactive user is refused, and list checks the type permission', async () => {
      const inactive = { ...sales, user: { ...sales.user, active: false } };
      await expect(listPurchaseOrders(inactive, {})).rejects.toThrow(ForbiddenError);
    });
  });

  describe('update', () => {
    it('re-checks the PO number and services only when they change', async () => {
      const taken = await newPurchaseOrder(w);
      const { purchaseOrder } = await newPurchaseOrder(w);
      const error = await rejection(
        updatePurchaseOrder(sales, purchaseOrder.id, {
          poNumber: taken.purchaseOrder.poNumber.toLowerCase(),
        }),
      );
      expect(fieldOf(error)).toBe('poNumber');
      // Re-sending its own number (another case) is not a clash.
      await updatePurchaseOrder(sales, purchaseOrder.id, {
        poNumber: purchaseOrder.poNumber.toLowerCase(),
      });
      expect(
        fieldOf(
          await rejection(
            updatePurchaseOrder(sales, purchaseOrder.id, { serviceIds: [w.certification] }),
          ),
        ),
      ).toBe('serviceIds');
      const updated = await updatePurchaseOrder(sales, purchaseOrder.id, {
        serviceIds: [w.audit],
      });
      expect(updated.services.map((s) => s.id)).toEqual([w.audit]);
      const links = await getDb().auditLog.findMany({
        where: { entityType: 'PurchaseOrderService', action: 'DELETE' },
      });
      expect(
        links.some(
          (r) => (r.before as { purchaseOrderId?: string }).purchaseOrderId === purchaseOrder.id,
        ),
      ).toBe(true);
    });

    it('changing the amount writes the new amount in minor units', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w);
      const updated = await updatePurchaseOrder(sales, purchaseOrder.id, {
        amount: '12,50,000',
        currency: 'INR',
      });
      expect(updated.amountMinor).toBe(12_50_000_00n);
    });
  });

  describe('AC7: project interplay', () => {
    it('a project with live POs cannot be deleted until they are', async () => {
      const { project, purchaseOrder } = await newPurchaseOrder(w);
      const error = await rejection(softDeleteProject(admin, project.id));
      expect(error).toBeInstanceOf(DomainError);
      expect((error as Error).message).toBe("Delete this project's purchase orders first (1)");
      const view = await getProject(admin, project.id);
      expect(view.permissions).toMatchObject({
        canDelete: false,
        deleteBlockedReason: 'Has purchase orders',
      });

      await softDeletePurchaseOrder(sales, purchaseOrder.id);
      expect((await getProject(admin, project.id)).permissions).toMatchObject({
        canDelete: true,
        deleteBlockedReason: null,
      });
      await softDeleteProject(admin, project.id);
      // Its POs cannot come back onto a deleted project.
      const restore = await rejection(restorePurchaseOrder(sales, purchaseOrder.id));
      expect(restore).toBeInstanceOf(DomainError);
    });

    it('a cancelled project keeps its POs readable and editable', async () => {
      const { project, purchaseOrder } = await newPurchaseOrder(w);
      await changeProjectStatus(admin, {
        id: project.id,
        to: 'CANCELLED',
        cancelReason: 'Stopped',
      });
      expect((await getPurchaseOrder(pm, purchaseOrder.id)).id).toBe(purchaseOrder.id);
      const updated = await updatePurchaseOrder(pm, purchaseOrder.id, {
        description: 'Work done before cancellation',
      });
      expect(updated.description).toBe('Work done before cancellation');
      await expect(getPurchaseOrderDraft(sales, project.id)).rejects.toThrow(DomainError);
    });

    it('a project cannot drop a service that a live PO uses', async () => {
      const { project, purchaseOrder } = await newPurchaseOrder(w, { serviceIds: [w.audit] });
      const error = await rejection(
        updateProject(admin, project.id, { serviceIds: [w.inspection] }),
      );
      expect(fieldOf(error)).toBe('serviceIds');
      expect((error as Error).message).toContain(purchaseOrder.poNumber);
      // Dropping a service no PO uses is fine.
      await updateProject(admin, project.id, { serviceIds: [w.audit] });
    });

    it('the draft pre-fills the first PO from the quotation, later ones with the remainder', async () => {
      const { quotation, project } = await newProject(w); // revenue ₹1,25,000.50, PO received 2026-04-01
      const first = await getPurchaseOrderDraft(sales, project.id);
      expect(first).toMatchObject({
        projectId: project.id,
        projectNumber: project.number,
        clientId: w.acme,
        clientName: 'Acme Pharma',
        quotationNumber: quotation.number,
        currency: 'INR',
        amountMinor: 12_500_050n,
        receivedDateFrom: 'quotation',
      });
      expect(toCalendarDateString(first.receivedDate)).toBe('2026-04-01');
      expect(first.serviceIds.sort()).toEqual([w.inspection, w.audit].sort());

      await createPurchaseOrder(sales, poInput(w, project.id, { amount: '1,00,000' }));
      const second = await getPurchaseOrderDraft(pm, project.id);
      expect(second).toMatchObject({ amountMinor: 25_000_50n, receivedDateFrom: 'today' });
      expect(toCalendarDateString(second.receivedDate)).toBe(today());

      await createPurchaseOrder(sales, poInput(w, project.id, { amount: '100', currency: 'USD' }));
      expect((await getPurchaseOrderDraft(sales, project.id)).amountMinor).toBeNull();

      const covered = await newProject(w);
      await createPurchaseOrder(sales, poInput(w, covered.project.id, { amount: '1,25,000.50' }));
      expect((await getPurchaseOrderDraft(sales, covered.project.id)).amountMinor).toBeNull();
    });

    it('getProject returns the live POs, totals per currency and over-coverage', async () => {
      const { project } = await newProject(w);
      const a = await createPurchaseOrder(sales, poInput(w, project.id, { amount: '1,00,000' }));
      const b = await createPurchaseOrder(sales, poInput(w, project.id, { amount: '50,000' }));
      const c = await createPurchaseOrder(
        sales,
        poInput(w, project.id, { amount: '200', currency: 'USD' }),
      );
      const deleted = await createPurchaseOrder(sales, poInput(w, project.id));
      await softDeletePurchaseOrder(sales, deleted.purchaseOrder.id);

      const view = await getProject(pm, project.id);
      expect(view.purchaseOrders.map((po) => po.id).sort()).toEqual(
        [a, b, c].map((x) => x.purchaseOrder.id).sort(),
      );
      expect(view.purchaseOrders[0]).toMatchObject({ status: 'PENDING', documentState: 'none' });
      expect(view.poTotals).toEqual({
        byCurrency: [
          { currency: 'INR', amountMinor: 1_50_000_00n },
          { currency: 'USD', amountMinor: 200_00n },
        ],
        currency: 'INR',
        coveredMinor: 1_50_000_00n,
        revenueMinor: 12_500_050n,
        overCovered: true,
      });
      expect((await listPurchaseOrdersForProject(pm, project.id)).length).toBe(3);
    });

    it('the quotation shows its project’s POs for the pipeline strip', async () => {
      const { quotation, purchaseOrder } = await newPurchaseOrder(w);
      const view = await getQuotation(pm, quotation.id);
      expect(view.projects[0]?.purchaseOrders.map((po) => po.id)).toEqual([purchaseOrder.id]);
    });
  });

  describe('AC9: soft delete and restore', () => {
    it('a deleted PO leaves lists, the project and search, except under Deleted', async () => {
      const { project, purchaseOrder } = await newPurchaseOrder(w);
      await softDeletePurchaseOrder(pm, purchaseOrder.id);
      expect(await ids(sales)).not.toContain(purchaseOrder.id);
      expect(await ids(sales, { recordStatus: 'deleted' })).toContain(purchaseOrder.id);
      expect((await getProject(sales, project.id)).purchaseOrders).toEqual([]);
      const found = await searchRecords(sales, { q: purchaseOrder.poNumber });
      expect(found.some((r) => r.id === purchaseOrder.id)).toBe(false);
      // The detail page still opens it, with Restore.
      const view = await getPurchaseOrder(sales, purchaseOrder.id);
      expect(view.deletedAt).toBeInstanceOf(Date);
      // Deleting twice is a clean error.
      await expect(softDeletePurchaseOrder(sales, purchaseOrder.id)).rejects.toThrow(NotFoundError);
    });

    it('restore is refused while the client has another live PO with the number', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w);
      await softDeletePurchaseOrder(sales, purchaseOrder.id);
      const other = await newProject(w);
      await createPurchaseOrder(
        sales,
        poInput(w, other.project.id, { poNumber: purchaseOrder.poNumber.toUpperCase() }),
      );
      const error = await rejection(restorePurchaseOrder(sales, purchaseOrder.id));
      expect(fieldOf(error)).toBe('poNumber');
    });

    it('only the PM, the pipeline owner and admins may delete', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w);
      await expect(softDeletePurchaseOrder(pm2, purchaseOrder.id)).rejects.toThrow(NotFoundError);
      await softDeletePurchaseOrder(admin, purchaseOrder.id);
      await expect(restorePurchaseOrder(sales2, purchaseOrder.id)).rejects.toThrow(NotFoundError);
      await restorePurchaseOrder(admin, purchaseOrder.id);
    });
  });

  describe('getPurchaseOrder', () => {
    it('returns the pipeline, totals and permissions the page needs', async () => {
      const { enquiry, quotation, project, purchaseOrder } = await newPurchaseOrder(w);
      const view = await getPurchaseOrder(pm, purchaseOrder.id);
      expect(view).toMatchObject({
        project: {
          id: project.id,
          number: project.number,
          status: 'NOT_STARTED',
          revenueMinor: 12_500_050n,
          currency: 'INR',
          manager: { id: pm.user.id },
          quotation: {
            id: quotation.id,
            number: quotation.number,
            owner: { id: sales.user.id },
            enquiry: { id: enquiry.id, number: enquiry.number },
          },
        },
        projectTotals: { coveredMinor: 1_00_000_00n, overCovered: false },
        permissions: { canUpdate: true, canDelete: true, deleteBlockedReason: null },
        documentState: 'none',
        document: null,
      });
    });
  });
});
