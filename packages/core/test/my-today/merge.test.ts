import { describe, expect, it } from 'vitest';
import { MY_TODAY_KINDS, type MyTodayKind } from '../../schemas/my-today.ts';
import {
  istDayOf,
  mergeCandidates,
  splitSections,
  type MyTodayCandidate,
} from '../../services/my-today-merge.ts';

const today = new Date('2026-09-28T00:00:00.000Z');
const day = (n: number) => new Date(today.getTime() + n * 86_400_000);

let seq = 0;
function candidate(
  kind: MyTodayKind,
  due: number,
  overrides: Partial<MyTodayCandidate> = {},
): MyTodayCandidate {
  const id = overrides.record?.id ?? `r${++seq}`;
  return {
    key: `INVOICE:${id}`,
    kind,
    dueDate: day(due),
    record: { type: 'INVOICE', id, label: `INV-${id}` },
    client: { id: 'c1', name: 'Acme' },
    title: kind,
    detail: null,
    amount: null,
    invoiceDate: null,
    followUpTarget: { entityType: 'INVOICE', entityId: id },
    ...overrides,
  };
}

describe('M11 merge: one row per record (Decision 4)', () => {
  it('keeps the highest-priority kind, the earliest due date, and lists the others', () => {
    const shared = {
      key: 'INVOICE:x',
      record: { type: 'INVOICE' as const, id: 'x', label: 'INV-x' },
    };
    const rows = mergeCandidates([
      candidate('FOLLOW_UP_DUE', -5, { ...shared, title: 'Chase', detail: 'Promised Friday' }),
      candidate('INVOICE_OVERDUE', -2, { ...shared, title: 'Chase payment' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'INVOICE_OVERDUE',
      title: 'Chase payment',
      dueDate: day(-5),
      alsoReasons: [{ kind: 'FOLLOW_UP_DUE', dueDate: day(-5) }],
    });
  });

  it('never merges different records', () => {
    const rows = mergeCandidates([candidate('INVOICE_DUE', 1), candidate('INVOICE_DUE', 1)]);
    expect(rows).toHaveLength(2);
  });

  it('priority follows MY_TODAY_KINDS for every pair', () => {
    for (const [i, higher] of MY_TODAY_KINDS.entries()) {
      for (const lower of MY_TODAY_KINDS.slice(i + 1)) {
        const shared = { key: 'K:1', record: { type: 'INVOICE' as const, id: '1', label: 'x' } };
        const [row] = mergeCandidates([candidate(lower, 0, shared), candidate(higher, 0, shared)]);
        expect(row!.kind).toBe(higher);
      }
    }
  });
});

describe('M11 sections (Decision 3)', () => {
  it('splits by due date: before today, today, then up to +7', () => {
    const rows = mergeCandidates([
      candidate('INVOICE_DUE', 0),
      candidate('INVOICE_OVERDUE', -1),
      candidate('INVOICE_DUE', 7),
      candidate('INVOICE_DUE', 1),
    ]);
    const { sections, counts } = splitSections(rows, today);
    expect(sections.overdue.map((r) => r.daysFromToday)).toEqual([-1]);
    expect(sections.dueToday.map((r) => r.daysFromToday)).toEqual([0]);
    expect(sections.comingUp.map((r) => r.daysFromToday)).toEqual([1, 7]);
    expect(counts).toMatchObject({ overdue: 1, dueToday: 1, comingUp: 2 });
    expect(counts.byKind).toMatchObject({ INVOICE_DUE: 3, INVOICE_OVERDUE: 1, STALE_ENQUIRY: 0 });
  });

  it('drops rows beyond the horizon', () => {
    const { counts } = splitSections(mergeCandidates([candidate('INVOICE_DUE', 8)]), today);
    expect(counts.comingUp).toBe(0);
  });

  it('sorts by due date, then kind priority, then client, then label', () => {
    const rows = mergeCandidates([
      candidate('STALE_ENQUIRY', -3, { client: { id: 'c', name: 'Beta' } }),
      candidate('FOLLOW_UP_DUE', -3, { client: { id: 'c', name: 'Zeta' } }),
      candidate('FOLLOW_UP_DUE', -3, { client: { id: 'c', name: 'Alpha' } }),
      candidate('INVOICE_OVERDUE', -1),
      candidate('INVOICE_OVERDUE', -9),
    ]);
    const { sections } = splitSections(rows, today);
    expect(sections.overdue.map((r) => [r.daysFromToday, r.kind, r.client.name])).toEqual([
      [-9, 'INVOICE_OVERDUE', 'Acme'],
      [-3, 'FOLLOW_UP_DUE', 'Alpha'],
      [-3, 'FOLLOW_UP_DUE', 'Zeta'],
      [-3, 'STALE_ENQUIRY', 'Beta'],
      [-1, 'INVOICE_OVERDUE', 'Acme'],
    ]);
  });

  it('caps each section at 100 rows and keeps the exact count (Decision 7)', () => {
    const many = Array.from({ length: 150 }, () => candidate('INVOICE_OVERDUE', -2));
    const { sections, counts } = splitSections(mergeCandidates(many), today);
    expect(sections.overdue).toHaveLength(100);
    expect(counts.overdue).toBe(150);
    expect(counts.byKind.INVOICE_OVERDUE).toBe(150);
  });
});

describe('M11 IST days', () => {
  it('23:30 IST (18:00 UTC) belongs to that IST day, 00:30 IST to the next', () => {
    expect(istDayOf(new Date('2026-09-28T18:00:00.000Z'))).toEqual(
      new Date('2026-09-28T00:00:00.000Z'),
    );
    expect(istDayOf(new Date('2026-09-28T19:00:00.000Z'))).toEqual(
      new Date('2026-09-29T00:00:00.000Z'),
    );
  });
});
