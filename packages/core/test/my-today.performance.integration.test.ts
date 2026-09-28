import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../clients.ts';
import { logFollowUp } from '../services/follow-up.service.ts';
import { getMyToday } from '../services/my-today.service.ts';
import { createEnquiry } from '../services/enquiry.service.ts';
import { daysFromToday, invoiceWorld, newInvoice } from './invoice-fixtures.ts';
import type { PoWorld } from './purchase-order-fixtures.ts';
import { countQueries } from './query-counter.ts';

/*
 * AC11: My Today costs a fixed number of queries whatever the data size (no query per row),
 * and stays fast on a busy user's list. The spec's "seed ×10" is approximated by a world
 * with several times the seed's rows for one Sales user and one PM.
 */

async function addLoad(w: PoWorld, n: number) {
  for (let i = 0; i < n; i++) {
    await newInvoice(w, { invoiceDate: daysFromToday(-40) }); // overdue for PM and owner
    const enquiry = await createEnquiry(w.sales, {
      clientId: w.acme,
      sectorId: w.pharma,
      serviceIds: [w.inspection],
      receivedDate: daysFromToday(-(20 + i)),
      source: 'EMAIL',
    });
    await logFollowUp(w.sales, {
      entityType: 'ENQUIRY',
      entityId: enquiry.id,
      date: daysFromToday(-5),
      channel: 'CALL',
      notes: `Load ${i}`,
      nextFollowUpDate: daysFromToday(-(i % 5)),
    });
    await createEnquiry(w.sales, {
      clientId: w.acme,
      sectorId: w.pharma,
      serviceIds: [w.inspection],
      receivedDate: daysFromToday(-(40 + i)),
      source: 'PHONE',
    }); // stale
  }
}

describe('AC11: My Today performance', () => {
  let w: PoWorld;
  beforeAll(async () => {
    w = await invoiceWorld();
  });
  afterAll(disconnectAll);

  it('uses the same number of queries for 3 and 30 records of each kind, under 300 ms', async () => {
    await addLoad(w, 3);
    const small = await countQueries(w.sales, () => getMyToday(w.sales));
    expect(small.result.counts.byKind.STALE_ENQUIRY).toBe(3);
    expect(small.queries).toBeGreaterThan(5); // the counter sees the service's queries

    await addLoad(w, 27);
    const large = await countQueries(w.sales, () => getMyToday(w.sales));
    expect(large.result.counts.byKind).toMatchObject({
      INVOICE_OVERDUE: 30,
      FOLLOW_UP_DUE: 30,
      STALE_ENQUIRY: 30,
    });
    expect(large.queries).toBe(small.queries);

    // Warm, then time the busiest lists.
    for (const ctx of [w.sales, w.pm]) {
      await getMyToday(ctx);
      const started = performance.now();
      await getMyToday(ctx);
      expect(performance.now() - started).toBeLessThan(300);
    }
  });
});
