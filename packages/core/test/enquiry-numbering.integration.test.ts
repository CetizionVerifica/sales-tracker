import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { withTx, type Ctx } from '../context.ts';
import type { CreateEnquiryInput } from '../schemas/enquiry.ts';
import { createClient } from '../services/client.service.ts';
import {
  createEnquiry,
  getEnquiry,
  restoreEnquiry,
  softDeleteEnquiry,
  updateEnquiry,
} from '../services/enquiry.service.ts';
import { formatNumber } from '../services/number-sequence.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

// AC12: ENQ-<year>-<NNNN>, sequential per calendar year of receivedDate, gap-free,
// immutable and never reused (M4 Decision 9).
describe('AC12: enquiry numbering (integration)', () => {
  let sales: Ctx;
  let admin: Ctx;
  let input: (receivedDate?: string) => CreateEnquiryInput;

  beforeAll(async () => {
    await resetDb(getDb());
    admin = ctxFor(
      actor('ADMIN', { id: (await createTestUser('admin@example.test', 'ADMIN')).id }),
    );
    sales = ctxFor(
      actor('SALES', { id: (await createTestUser('sales@example.test', 'SALES')).id }),
    );
    const sectorId = (await createSector(admin, { name: 'Pharma' })).id;
    const serviceId = (await createService(admin, { name: 'Inspection' })).id;
    const clientId = (await createClient(admin, { name: 'Acme', sectorId })).id;
    input = (receivedDate = '2026-03-10') => ({
      clientId,
      sectorId,
      serviceIds: [serviceId],
      receivedDate,
      source: 'PHONE',
    });
  });
  afterAll(disconnectAll);

  beforeEach(async () => {
    // Fresh counters per test; enquiries from earlier tests keep their (unique) numbers,
    // so tests use years no other test uses.
    await getDb().$executeRawUnsafe('TRUNCATE "number_sequence"');
    await getDb().$executeRawUnsafe(`DELETE FROM "enquiry_service"`);
    await getDb().$executeRawUnsafe(`DELETE FROM "enquiry"`);
  });

  it('formats with four digits and widens past 9999', () => {
    expect(formatNumber('ENQ', 2026, 1)).toBe('ENQ-2026-0001');
    expect(formatNumber('ENQ', 2026, 42)).toBe('ENQ-2026-0042');
    expect(formatNumber('ENQ', 2026, 10000)).toBe('ENQ-2026-10000');
  });

  it('numbers each year of receivedDate independently', async () => {
    const a = await createEnquiry(sales, input('2026-01-02'));
    const b = await createEnquiry(sales, input('2026-09-01'));
    const c = await createEnquiry(sales, input('2025-06-15'));
    expect([a.number, b.number, c.number]).toEqual([
      'ENQ-2026-0001',
      'ENQ-2026-0002',
      'ENQ-2025-0001',
    ]);
  });

  it('gives 20 concurrent creates 20 distinct, gap-free numbers', async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, () => createEnquiry(sales, input())),
    );
    const numbers = created.map((e) => e.number).sort();
    expect(numbers).toEqual(
      Array.from({ length: 20 }, (_, i) => `ENQ-2026-${String(i + 1).padStart(4, '0')}`),
    );
  });

  it('does not consume a number when the create rolls back or fails validation', async () => {
    await expect(
      withTx(sales, async () => {
        await createEnquiry(sales, input());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(createEnquiry(sales, { ...input(), serviceIds: [] })).rejects.toThrow();
    expect((await createEnquiry(sales, input())).number).toBe('ENQ-2026-0001');
  });

  it('keeps the number through soft delete and never reuses it', async () => {
    const first = await createEnquiry(sales, input());
    await softDeleteEnquiry(sales, first.id);
    expect((await getEnquiry(sales, first.id)).number).toBe('ENQ-2026-0001');
    expect((await createEnquiry(sales, input())).number).toBe('ENQ-2026-0002');
    expect((await restoreEnquiry(sales, first.id)).number).toBe('ENQ-2026-0001');
  });

  it('never changes the number, even when receivedDate moves to another year', async () => {
    const enquiry = await createEnquiry(sales, input('2026-01-05'));
    const moved = await updateEnquiry(sales, enquiry.id, { receivedDate: '2025-12-30' });
    expect(moved.number).toBe(enquiry.number);
    const renamed = await updateEnquiry(sales, enquiry.id, {
      description: 'x',
      number: 'ENQ-1999-0001',
    } as Parameters<typeof updateEnquiry>[2]);
    expect(renamed.number).toBe(enquiry.number);
  });

  it('widens past 9999 instead of failing', async () => {
    await withTx(admin, (tx) =>
      tx.numberSequence.create({ data: { id: 'ENQ-2026', lastValue: 9999 } }),
    );
    expect((await createEnquiry(sales, input())).number).toBe('ENQ-2026-10000');
  });

  it('audits the counter with the enquiry, in one request', async () => {
    const enquiry = await createEnquiry(sales, input());
    const [created] = await getDb().auditLog.findMany({
      where: { entityType: 'Enquiry', entityId: enquiry.id },
    });
    const counter = await getDb().auditLog.findMany({
      where: { requestId: created!.requestId, entityType: 'NumberSequence' },
    });
    expect(counter.at(-1)).toMatchObject({ entityId: 'ENQ-2026', source: 'web' });
  });
});
