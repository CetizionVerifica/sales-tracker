import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import type { ListPurchaseOrdersInput } from '../schemas/purchase-order.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { confirmExtraction, runExtraction, uploadDocument } from '../services/document.service.ts';
import {
  createPurchaseOrder,
  listPurchaseOrders,
  softDeletePurchaseOrder,
} from '../services/purchase-order.service.ts';
import { searchRecords } from '../services/search.service.ts';
import { purchaseOrderStatusCounts } from '../services/summary.service.ts';
import { samplePdf, sha256Hex } from './documents/files.ts';
import { ensureSystemCtx } from './helpers.ts';
import { newProject } from './project-fixtures.ts';
import { poInput, poWorld, type PoWorld } from './purchase-order-fixtures.ts';

// AC10 and AC11: filters, sort, pagination, counts and ⌘K search, on a fixed data set.
describe('purchase order list, counts and search (integration)', () => {
  let w: PoWorld;
  const mock = createMockExtractor();
  const po: Record<string, string> = {};
  let unassignedProject: string;
  let pm2Project: string;

  const ids = async (ctx: Ctx, input: ListPurchaseOrdersInput = {}) =>
    (await listPurchaseOrders(ctx, { pageSize: 100, ...input })).items.map((row) => row.id);

  const setStatus = (id: string, status: 'PAID' | 'OVERDUE') =>
    // Test-only: M9 has no invoices, so the derived statuses are forced for the filters.
    getDb().$executeRawUnsafe(
      `UPDATE "purchase_order" SET status = $1::"PurchaseOrderStatus" WHERE id = $2`,
      status,
      id,
    );

  beforeAll(async () => {
    w = await poWorld();
    setDocumentDeps({ extractor: mock, fileStore: createMemoryFileStore() });
    await getDocumentsQueue().obliterate({ force: true });
    const system = await ensureSystemCtx();

    // Project A (Acme, PM pm, owner sales): three POs.
    const a = await newProject(w, { name: 'Boiler inspection' });
    po.alpha = (
      await createPurchaseOrder(
        w.sales,
        poInput(w, a.project.id, {
          poNumber: 'ALPHA-100',
          receivedDate: '2026-01-10',
          amount: '3,00,000',
          serviceIds: [w.inspection],
          paymentTerms: '50% advance, balance on completion',
        }),
      )
    ).purchaseOrder.id;
    po.beta = (
      await createPurchaseOrder(
        w.sales,
        poInput(w, a.project.id, {
          poNumber: 'BETA-200',
          receivedDate: '2026-02-10',
          amount: '50',
          currency: 'USD',
          serviceIds: [w.audit],
          paymentTerms: 'Net 45',
          paymentTermsDays: 45,
        }),
      )
    ).purchaseOrder.id;
    po.gamma = (
      await createPurchaseOrder(
        w.pm,
        poInput(w, a.project.id, {
          poNumber: 'GAMMA-300',
          receivedDate: '2026-03-10',
          amount: '10,000',
        }),
      )
    ).purchaseOrder.id;

    // Project B (Globex, unassigned, owner sales2): one PO.
    const b = await newProject(w, { name: 'Tank audit', managerId: '' }, w.sales2, w.globex);
    unassignedProject = b.project.id;
    po.delta = (
      await createPurchaseOrder(
        w.sales2,
        poInput(w, b.project.id, { poNumber: 'DELTA-400', receivedDate: '2026-04-10' }),
      )
    ).purchaseOrder.id;

    // Project C (Acme, PM pm2, owner sales): one PO.
    const c = await newProject(w, { name: 'Silo survey', managerId: w.pm2.user.id });
    pm2Project = c.project.id;
    po.epsilon = (
      await createPurchaseOrder(
        w.sales,
        poInput(w, c.project.id, { poNumber: 'EPSILON-500', receivedDate: '2026-05-10' }),
      )
    ).purchaseOrder.id;

    await setStatus(po.beta!, 'PAID');
    await setStatus(po.gamma!, 'OVERDUE');

    // Documents: alpha to review, beta reviewed, gamma could not read, delta still reading.
    const upload = async (
      ctx: Ctx,
      id: string,
      behaviour?: Parameters<typeof mock.register>[1],
    ) => {
      const bytes = samplePdf(`po ${id}`);
      if (behaviour) mock.register(await sha256Hex(bytes), behaviour);
      return uploadDocument(
        ctx,
        { kind: 'PURCHASE_ORDER', entityId: id },
        { bytes, mimeType: 'application/pdf', filename: 'po.pdf' },
      );
    };
    const alphaDoc = await upload(w.sales, po.alpha!);
    await runExtraction(system, alphaDoc.id);
    const betaDoc = await upload(w.sales, po.beta!);
    await runExtraction(system, betaDoc.id);
    await confirmExtraction(w.sales, { documentId: betaDoc.id, apply: {} });
    const gammaDoc = await upload(w.pm, po.gamma!, { type: 'fail', message: 'Unreadable' });
    await runExtraction(system, gammaDoc.id);
    await upload(w.sales2, po.delta!);
    // A deleted PO is never counted or listed by default.
    const deleted = await createPurchaseOrder(
      w.sales,
      poInput(w, a.project.id, { poNumber: 'ZETA-600' }),
    );
    await softDeletePurchaseOrder(w.sales, deleted.purchaseOrder.id);
  });
  afterAll(async () => {
    await closeDocumentsQueue();
    await disconnectAll();
  });

  it('filters by status, project, client, service and currency', async () => {
    expect(await ids(w.admin, { status: ['PAID'] })).toEqual([po.beta]);
    expect((await ids(w.admin, { status: ['PENDING', 'OVERDUE'] })).sort()).toEqual(
      [po.alpha, po.gamma, po.delta, po.epsilon].sort(),
    );
    expect(await ids(w.admin, { clientId: w.globex })).toEqual([po.delta]);
    expect(await ids(w.admin, { projectId: pm2Project })).toEqual([po.epsilon]);
    expect((await ids(w.admin, { serviceId: w.audit })).sort()).toEqual(
      [po.beta, po.gamma, po.delta, po.epsilon].sort(),
    );
    expect(await ids(w.admin, { currency: ['USD'] })).toEqual([po.beta]);
  });

  it('filters by manager (including unassigned), owner and received range', async () => {
    expect(await ids(w.admin, { managerId: 'none' })).toEqual([po.delta]);
    expect(await ids(w.admin, { managerId: w.pm2.user.id })).toEqual([po.epsilon]);
    expect(await ids(w.admin, { ownerId: w.sales2.user.id })).toEqual([po.delta]);
    expect(
      await ids(w.admin, {
        receivedFrom: '2026-02-01',
        receivedTo: '2026-03-31',
        sort: 'receivedDate',
        dir: 'asc',
      }),
    ).toEqual([po.beta, po.gamma]);
    expect(unassignedProject).toBeTruthy();
  });

  it('filters by document state', async () => {
    expect(await ids(w.admin, { document: 'toReview' })).toEqual([po.alpha]);
    expect(await ids(w.admin, { document: 'reviewed' })).toEqual([po.beta]);
    expect(await ids(w.admin, { document: 'failed' })).toEqual([po.gamma]);
    expect(await ids(w.admin, { document: 'reading' })).toEqual([po.delta]);
    expect(await ids(w.admin, { document: 'none' })).toEqual([po.epsilon]);
    const [alpha] = (await listPurchaseOrders(w.admin, { q: 'ALPHA' })).items;
    expect(alpha?.documentState).toBe('toReview');
  });

  it('searches PO number, project number and name, client name and terms', async () => {
    expect(await ids(w.admin, { q: 'alpha-1' })).toEqual([po.alpha]);
    expect((await ids(w.admin, { q: 'boiler' })).sort()).toEqual(
      [po.alpha, po.beta, po.gamma].sort(),
    );
    expect(await ids(w.admin, { q: 'globex' })).toEqual([po.delta]);
    expect(await ids(w.admin, { q: 'balance on completion' })).toEqual([po.alpha]);
    const [epsilon] = (await listPurchaseOrders(w.admin, { q: 'EPSILON' })).items;
    expect((await ids(w.admin, { q: epsilon!.project.number })).sort()).toEqual([po.epsilon]);
  });

  it('sorts, paginates and lists deleted POs only under Deleted', async () => {
    expect(await ids(w.admin)).toEqual([po.epsilon, po.delta, po.gamma, po.beta, po.alpha]);
    expect(await ids(w.admin, { sort: 'poNumber', dir: 'asc' })).toEqual([
      po.alpha,
      po.beta,
      po.delta,
      po.epsilon,
      po.gamma,
    ]);
    expect((await ids(w.admin, { sort: 'amount', dir: 'desc' }))[0]).toBe(po.alpha);
    const page = await listPurchaseOrders(w.admin, { pageSize: 2, page: 2 });
    expect(page).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(page.items.map((row) => row.id)).toEqual([po.gamma, po.beta]);
    const deleted = await listPurchaseOrders(w.admin, { recordStatus: 'deleted' });
    expect(deleted.items.map((row) => row.poNumber)).toEqual(['ZETA-600']);
  });

  it('combines filters with the RBAC scope', async () => {
    expect((await ids(w.pm)).sort()).toEqual([po.alpha, po.beta, po.gamma].sort());
    expect(await ids(w.pm, { status: ['OVERDUE'] })).toEqual([po.gamma]);
    expect((await ids(w.sales)).sort()).toEqual([po.alpha, po.beta, po.gamma, po.epsilon].sort());
    expect(await ids(w.sales, { clientId: w.globex })).toEqual([]);
    expect(await ids(w.sales2)).toEqual([po.delta]);
    expect(await ids(w.pm2)).toEqual([po.epsilon]);
  });

  it('status counts match the filtered list for each chip', async () => {
    for (const ctx of [w.admin, w.sales, w.pm, w.sales2]) {
      const counts = await purchaseOrderStatusCounts(ctx);
      for (const status of ['PENDING', 'PAID', 'OVERDUE'] as const) {
        expect(counts[status]).toBe((await ids(ctx, { status: [status] })).length);
      }
      expect(counts.toReview).toBe((await ids(ctx, { document: 'toReview' })).length);
    }
    expect(await purchaseOrderStatusCounts(w.admin)).toEqual({
      PENDING: 3,
      PAID: 1,
      OVERDUE: 1,
      toReview: 1,
    });
  });

  it('AC11: ⌘K finds a PO by its number only for users who can read it', async () => {
    const hit = (await searchRecords(w.pm, { q: 'gamma-3' })).find(
      (r) => r.type === 'PURCHASE_ORDER',
    );
    expect(hit).toMatchObject({ id: po.gamma, label: 'PO GAMMA-300' });
    expect(hit?.detail).toMatch(/^Acme Pharma · PRJ-/);
    expect(
      (await searchRecords(w.pm2, { q: 'gamma-3' })).some((r) => r.type === 'PURCHASE_ORDER'),
    ).toBe(false);
    expect(
      (await searchRecords(w.sales2, { q: 'gamma-3' })).some((r) => r.type === 'PURCHASE_ORDER'),
    ).toBe(false);
    expect((await searchRecords(w.sales2, { q: 'delta' })).map((r) => r.id)).toContain(po.delta);
  });
});
