import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { withTx, type Ctx } from '../context.ts';
import { DomainError } from '../errors.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { confirmExtraction, runExtraction, uploadDocument } from '../services/document.service.ts';
import { changeProjectStatus, softDeleteProject } from '../services/project.service.ts';
import { createPurchaseOrder, getPurchaseOrder } from '../services/purchase-order.service.ts';
import { samplePdf } from './documents/files.ts';
import { ensureSystemCtx } from './helpers.ts';
import { newProject } from './project-fixtures.ts';
import {
  newPurchaseOrder,
  poInput,
  poWorld,
  uniquePoNumber,
  type PoWorld,
} from './purchase-order-fixtures.ts';

const ROUNDS = 10;

const settled = (results: PromiseSettledResult<unknown>[]) => ({
  ok: results.filter((r) => r.status === 'fulfilled').length,
  errors: results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason as unknown),
});

describe('purchase order database rules and races (integration)', () => {
  let w: PoWorld;
  let system: Ctx;

  beforeAll(async () => {
    w = await poWorld();
    setDocumentDeps({ extractor: createMockExtractor(), fileStore: createMemoryFileStore() });
    await getDocumentsQueue().obliterate({ force: true });
    system = await ensureSystemCtx();
  });
  afterAll(async () => {
    await closeDocumentsQueue();
    await disconnectAll();
  });

  it('the database rejects rows that break the PO rules, even via raw SQL', async () => {
    const { purchaseOrder } = await newPurchaseOrder(w);
    const raw = (sql: string) => getDb().$executeRawUnsafe(sql, purchaseOrder.id);
    await expect(
      raw(`UPDATE "purchase_order" SET "amountMinor" = 0 WHERE id = $1`),
    ).rejects.toThrow(/purchase_order_amount_positive/);
    await expect(raw(`UPDATE "purchase_order" SET currency = 'inr' WHERE id = $1`)).rejects.toThrow(
      /purchase_order_currency_iso/,
    );
    await expect(
      raw(`UPDATE "purchase_order" SET "poNumber" = '   ' WHERE id = $1`),
    ).rejects.toThrow(/purchase_order_po_number_length/);
    await expect(
      raw(`UPDATE "purchase_order" SET "poNumber" = '${'x'.repeat(65)}' WHERE id = $1`),
    ).rejects.toThrow(/purchase_order_po_number_length/);
    await expect(
      raw(`UPDATE "purchase_order" SET "paymentTermsDays" = 366 WHERE id = $1`),
    ).rejects.toThrow(/purchase_order_terms_days_range/);
  });

  it('keeps the partial, case-insensitive unique index on live PO numbers per client', async () => {
    const [index] = await getDb().$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'purchase_order_live_client_number_key'`;
    expect(index?.indexdef).toMatch(
      /UNIQUE INDEX .* \("clientId", lower\("poNumber"\)\) WHERE \("deletedAt" IS NULL\)/,
    );
  });

  // AC12: races fail cleanly.
  it('lets exactly one of two racing creates with the same client and number succeed', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { project } = await newProject(w);
      const number = uniquePoNumber();
      const { ok, errors } = settled(
        await Promise.allSettled([
          createPurchaseOrder(w.sales, poInput(w, project.id, { poNumber: number })),
          createPurchaseOrder(w.pm, poInput(w, project.id, { poNumber: number.toLowerCase() })),
        ]),
      );
      expect(ok).toBe(1);
      expect(errors[0]).toBeInstanceOf(DomainError);
      expect((errors[0] as DomainError).field).toBe('poNumber');
    }
  });

  it('never leaves a live PO on a deleted project when a create races the delete', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { project } = await newProject(w);
      const results = await Promise.allSettled([
        createPurchaseOrder(w.sales, poInput(w, project.id)),
        softDeleteProject(w.admin, project.id),
      ]);
      const deleted = await getDb().project.count({
        where: { id: project.id, deletedAt: { not: null } },
      });
      const livePos = await getDb().purchaseOrder.count({ where: { projectId: project.id } });
      expect(deleted + livePos).toBe(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    }
  });

  it('never creates a PO after a cancel committed', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { project } = await newProject(w);
      const [create, cancel] = await Promise.allSettled([
        createPurchaseOrder(w.sales, poInput(w, project.id)),
        changeProjectStatus(w.admin, { id: project.id, to: 'CANCELLED', cancelReason: 'Stopped' }),
      ]);
      expect(cancel.status).toBe('fulfilled');
      if (create.status === 'rejected') {
        expect((create.reason as Error).message).toBe(
          'A cancelled project takes no new purchase orders',
        );
      }
    }
  });

  /**
   * Runs `write` in a transaction that stays open until the returned `commit` is called, so
   * another request can be started while it is uncommitted.
   */
  async function holdOpen(ctx: Ctx, write: () => Promise<unknown>) {
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    let written!: () => void;
    const ready = new Promise<void>((resolve) => (written = resolve));
    const done = withTx(ctx, async () => {
      await write();
      written();
      await gate;
    });
    await ready;
    return { commit, done };
  }

  const state = (promise: Promise<unknown>) =>
    Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
    ]);

  it('a create waits for an uncommitted cancel or delete of its project, then fails', async () => {
    for (const [label, write] of [
      [
        'cancel',
        (id: string) =>
          changeProjectStatus(w.admin, { id, to: 'CANCELLED', cancelReason: 'Stopped' }),
      ],
      ['delete', (id: string) => softDeleteProject(w.admin, id)],
    ] as const) {
      const { project } = await newProject(w);
      const held = await holdOpen(w.admin, () => write(project.id));
      const create = createPurchaseOrder(w.sales, poInput(w, project.id));
      expect(await state(create), label).toBe('waiting');
      held.commit();
      await held.done;
      await expect(create, label).rejects.toThrow(
        label === 'cancel'
          ? 'A cancelled project takes no new purchase orders'
          : 'project not found',
      );
      expect(await getDb().purchaseOrder.count({ where: { projectId: project.id } })).toBe(0);
    }
  });

  it('a project delete waits for an uncommitted PO create, then is refused', async () => {
    const { project } = await newProject(w);
    const held = await holdOpen(w.sales, () =>
      createPurchaseOrder(w.sales, poInput(w, project.id)),
    );
    const remove = softDeleteProject(w.admin, project.id);
    expect(await state(remove)).toBe('waiting');
    held.commit();
    await held.done;
    await expect(remove).rejects.toThrow("Delete this project's purchase orders first (1)");
  });

  it('lets exactly one of two confirms setting the same number on two POs succeed', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const number = uniquePoNumber();
      const docs: string[] = [];
      const pos: string[] = [];
      for (let i = 0; i < 2; i++) {
        const { purchaseOrder } = await newPurchaseOrder(w);
        const doc = await uploadDocument(
          w.sales,
          { kind: 'PURCHASE_ORDER', entityId: purchaseOrder.id },
          {
            bytes: samplePdf(`race ${round} ${i}`),
            mimeType: 'application/pdf',
            filename: 'po.pdf',
          },
        );
        await runExtraction(system, doc.id);
        docs.push(doc.id);
        pos.push(purchaseOrder.id);
      }
      const { ok, errors } = settled(
        await Promise.allSettled(
          docs.map((documentId) =>
            confirmExtraction(w.sales, { documentId, apply: { poNumber: number } }),
          ),
        ),
      );
      expect(ok).toBe(1);
      expect((errors[0] as DomainError).field).toBe('poNumber');
      const numbers = await Promise.all(
        pos.map(async (id) => (await getPurchaseOrder(w.sales, id)).poNumber),
      );
      expect(numbers.filter((n) => n === number)).toHaveLength(1);
    }
  });
});
