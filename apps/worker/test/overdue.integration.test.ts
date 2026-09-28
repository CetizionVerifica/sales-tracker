import { disconnectAll, getInvoice, getPurchaseOrder, type Ctx } from '@sales-tracker/core';
import { Queue, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisConnection, getDb } from '../../../packages/core/clients.ts';
import { getEnv } from '../../../packages/core/env.ts';
import { ensureSystemCtx } from '../../../packages/core/test/helpers.ts';
import { invoiceWorld, newInvoice } from '../../../packages/core/test/invoice-fixtures.ts';
import type { PoWorld } from '../../../packages/core/test/purchase-order-fixtures.ts';
import {
  IMPORT_EXPIRE_JOB,
  OVERDUE_JOB,
  OVERDUE_SCHEDULE,
  processSystemJob,
  startWorker,
  SYSTEM_QUEUE,
} from '../src/worker.ts';

// AC5, worker side: the nightly overdue check is scheduled once and runs as the system.

describe('overdue job (integration: real Redis)', () => {
  let w: PoWorld;
  let system: Ctx;
  const connection = createRedisConnection();
  const queue = new Queue(SYSTEM_QUEUE, { connection, prefix: getEnv().QUEUE_PREFIX });

  beforeAll(async () => {
    w = await invoiceWorld();
    system = await ensureSystemCtx();
    await queue.obliterate({ force: true });
  });
  afterAll(async () => {
    await queue.close();
    await connection.quit();
    await disconnectAll();
  });

  it('the processor marks past-due invoices OVERDUE as the system', async () => {
    const { invoice, purchaseOrder } = await newInvoice(w);
    // Test-only: move a PENDING invoice's dates into the past, as time passing would.
    await getDb().$executeRawUnsafe(
      `UPDATE "invoice" SET "invoiceDate" = "invoiceDate" - 40, "dueDate" = "dueDate" - 40 WHERE id = $1`,
      invoice.id,
    );
    const result = await processSystemJob({ name: OVERDUE_JOB } as Job);
    expect(result).toMatchObject({ markedOverdue: 1, failed: 0 });
    expect((await getInvoice(w.admin, invoice.id)).status).toBe('OVERDUE');
    expect((await getPurchaseOrder(w.admin, purchaseOrder.id)).status).toBe('OVERDUE');
    const row = await getDb().auditLog.findFirst({
      where: { entityType: 'Invoice', entityId: invoice.id, changedFields: { has: 'status' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).toMatchObject({ source: 'system', actorId: system.user.id });
  });

  it('other system job names stay no-ops', async () => {
    expect(await processSystemJob({ name: 'ping' } as Job)).toEqual({ ok: true, name: 'ping' });
  });

  it('registers the nightly schedule once across restarts, and catches up on start', async () => {
    const { invoice } = await newInvoice(w);
    await getDb().$executeRawUnsafe(
      `UPDATE "invoice" SET "invoiceDate" = "invoiceDate" - 40, "dueDate" = "dueDate" - 40 WHERE id = $1`,
      invoice.id,
    );
    const first = await startWorker({ sweep: false });
    await first.close();
    // The catch-up run on start already marked it.
    expect((await getInvoice(w.admin, invoice.id)).status).toBe('OVERDUE');
    const second = await startWorker({ sweep: false });
    await second.close();

    // Two schedulers on this queue since M10b added its own nightly check (import expiry).
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(2);
    expect(schedulers.find((s) => s.key === OVERDUE_JOB)).toMatchObject({
      key: OVERDUE_JOB,
      pattern: OVERDUE_SCHEDULE,
      tz: 'Asia/Kolkata',
    });
    expect(schedulers.find((s) => s.key === IMPORT_EXPIRE_JOB)).toBeTruthy();
  });
});
