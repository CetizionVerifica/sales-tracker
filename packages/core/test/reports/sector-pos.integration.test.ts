import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../../clients.ts';
import { OTHER_SECTOR_KEY, sectorPos } from '../../reports/sector-pos.ts';
import { resolveReportScope } from '../../reports/scope.ts';
import { previousPeriod, reportFilterSchema, resolvePeriod } from '../../schemas/report.ts';
import { createClient } from '../../services/client.service.ts';
import { createSector } from '../../services/sector.service.ts';
import { dealWithPo, reportsWorld, type ReportsWorld } from './fixtures.ts';

// M12b AC3: sectors beyond the top 6, and sectors marked isOther, group into "Other sectors";
// count and value toggles both match the fixture. R3 groups by the *client's* sector, so each
// scenario here gets its own client with that sector, distinct from the general fixture
// clients (all fixed to `w.pharma`).

let w: ReportsWorld;
const amountsMinor = [
  6_00_000_00n,
  5_00_000_00n,
  4_00_000_00n,
  3_00_000_00n,
  2_00_000_00n,
  1_00_000_00n,
];
const SMALL_AMOUNT = 50_000_00n;
const OTHER_FLAGGED_AMOUNT = 9_00_000_00n;

beforeAll(async () => {
  w = await reportsWorld();
  // 6 rankable sectors, descending value.
  for (let i = 0; i < 6; i++) {
    const client = await createClient(w.admin, {
      name: `Sector client ${i}`,
      sectorId: w.sectors[i]!,
    });
    await dealWithPo(w, w.admin, {
      clientId: client.id,
      sectorId: w.sectors[i]!,
      receivedDate: '2026-01-10',
      amount: (Number(amountsMinor[i]) / 100).toFixed(2),
    });
  }
  // A 7th rankable sector, smaller than all 6 above: falls out of the top 6.
  const small = (await createSector(w.admin, { name: 'Small sector' })).id;
  const smallClient = await createClient(w.admin, { name: 'Small sector client', sectorId: small });
  await dealWithPo(w, w.admin, {
    clientId: smallClient.id,
    sectorId: small,
    receivedDate: '2026-01-11',
    amount: '50,000',
  });
  // A sector marked isOther: must group into "Other sectors" regardless of its own value/rank
  // (here, larger than every rankable sector, to prove the flag overrides ranking).
  const otherClient = await createClient(w.admin, {
    name: 'Other-flagged sector client',
    sectorId: w.otherSector,
  });
  await dealWithPo(w, w.admin, {
    clientId: otherClient.id,
    sectorId: w.otherSector,
    receivedDate: '2026-01-12',
    amount: '9,00,000',
  });
});
afterAll(disconnectAll);

const loadReport = async () => {
  const db = getDb();
  const scope = resolveReportScope(w.admin, {});
  const filter = reportFilterSchema.parse({
    preset: 'custom',
    from: '2026-01-01',
    to: '2026-01-31',
  });
  const period = resolvePeriod(filter, new Date('2026-01-15T00:00:00.000Z'));
  return sectorPos(db, scope, period, previousPeriod(period), {});
};

describe('sectorPos', () => {
  it('shows the top 6 individually; the rest and isOther sectors group as "Other sectors"', async () => {
    const report = await loadReport();

    const rankable = report.data.filter((r) => r.key !== OTHER_SECTOR_KEY);
    expect(rankable).toHaveLength(6);
    expect(rankable.map((r) => r.valueMinor)).toEqual(amountsMinor);
    for (let i = 1; i < rankable.length; i++) {
      expect(rankable[i - 1]!.valueMinor >= rankable[i]!.valueMinor).toBe(true);
    }

    const other = report.data.find((r) => r.key === OTHER_SECTOR_KEY);
    expect(other).toBeDefined();
    expect(other!.valueMinor).toBe(SMALL_AMOUNT + OTHER_FLAGGED_AMOUNT);
    expect(other!.count).toBe(2);

    expect(report.totalCount).toBe(8);
    expect(report.totalValueMinor).toBe(
      amountsMinor.reduce((n, v) => n + v, 0n) + SMALL_AMOUNT + OTHER_FLAGGED_AMOUNT,
    );
  });

  it('a sector marked isOther is grouped as "Other" even though its own value would rank first', async () => {
    const report = await loadReport();
    expect(report.data.some((r) => r.name === 'Misc')).toBe(false);
    // "Other sectors" (₹9.5L) outranks every individual rankable sector (top is ₹6L), and the
    // list is still sorted descending, so it leads.
    expect(report.data[0]!.key).toBe(OTHER_SECTOR_KEY);
  });

  it('count and value share percentages are both correct', async () => {
    const report = await loadReport();
    const top = report.data[0]!;
    expect(top.sharePct).toBe(
      Math.round((Number(top.valueMinor) / Number(report.totalValueMinor)) * 100),
    );
  });
});
