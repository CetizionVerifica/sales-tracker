import { readFileSync, writeFileSync } from 'node:fs';
import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import type { MyToday } from '../schemas/my-today.ts';
import { runExtraction, uploadDocument } from '../services/document.service.ts';
import { getMyToday } from '../services/my-today.service.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { DEV_USERS, seed } from '../system/seed.ts';
import { samplePdf, sha256Hex } from './documents/files.ts';
import { ensureSystemCtx } from './helpers.ts';

/*
 * AC1, the PLAN.md "done when": My Today shows the correct items for the seeded data. The
 * clock is pinned (only `Date`), so the seed's relative dates, the record numbers and the
 * expected rows are the same on any day. Regenerate after a deliberate seed change with
 * UPDATE_GOLDEN=1, and review the diff: every line is a claim about a seeded record.
 */

const NOW = new Date('2026-09-28T06:30:00.000Z'); // 12:00 IST
const FIXTURE = new URL('./fixtures/my-today.golden.json', import.meta.url);

type Golden = Record<string, Record<'overdue' | 'dueToday' | 'comingUp', string[]>>;

const describeRow = (row: MyToday['sections']['overdue'][number]) =>
  [
    row.kind,
    row.record.label,
    `${row.daysFromToday >= 0 ? '+' : ''}${row.daysFromToday}`,
    ...row.alsoReasons.map((r) => `also ${r.kind}`),
  ].join(' | ');

function summarise(result: MyToday): Golden[string] {
  return {
    overdue: result.sections.overdue.map(describeRow),
    dueToday: result.sections.dueToday.map(describeRow),
    comingUp: result.sections.comingUp.map(describeRow),
  };
}

describe('AC1: My Today on the development seed (golden)', () => {
  const actual: Golden = {};

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await resetDb(getDb());
    await seed({
      adminEmail: 'admin@example.com',
      adminPassword: 'admin-dev-password',
      devUsers: true,
    });

    // The seed:documents step, offline: one extracted invoice document awaiting review.
    const mock = createMockExtractor();
    setDocumentDeps({ extractor: mock, fileStore: createMemoryFileStore() });
    await getDocumentsQueue().obliterate({ force: true });
    const invoice = await getDb().invoice.findFirstOrThrow({
      where: { status: 'OVERDUE' },
      select: { id: true, purchaseOrder: { select: { project: { select: { managerId: true } } } } },
      orderBy: { invoiceNumber: 'asc' },
    });
    const managerId = invoice.purchaseOrder.project.managerId!;
    const pm = await getDb().user.findUniqueOrThrow({
      where: { id: managerId },
      select: { id: true, role: true, active: true },
    });
    const bytes = samplePdf('golden invoice');
    mock.register(await sha256Hex(bytes), { type: 'result', wire: {} });
    const doc = await uploadDocument(
      { user: pm, source: 'system' },
      { kind: 'INVOICE', entityId: invoice.id },
      { bytes, mimeType: 'application/pdf', filename: 'golden-invoice.pdf' },
    );
    await runExtraction(await ensureSystemCtx(), doc.id);

    const users = await getDb().user.findMany({
      where: { email: { in: [...DEV_USERS.map((u) => u.email), 'admin@example.com'] } },
      select: { id: true, email: true, role: true, active: true },
    });
    for (const user of users.sort((a, b) => a.email.localeCompare(b.email))) {
      const ctx: Ctx = {
        user: { id: user.id, role: user.role, active: user.active },
        source: 'web',
      };
      actual[user.email] = summarise(await getMyToday(ctx));
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    await closeDocumentsQueue();
    await disconnectAll();
  });

  it('every seeded user sees exactly the expected rows, by section', () => {
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Golden;
    expect(actual).toEqual(expected);
  });

  it('covers every row kind, the merge and the section boundaries', () => {
    const lines = Object.values(actual).flatMap((s) => [
      ...s.overdue,
      ...s.dueToday,
      ...s.comingUp,
    ]);
    for (const kind of [
      'INVOICE_OVERDUE',
      'INVOICE_DUE',
      'QUOTATION_AWAITING_REPLY',
      'FOLLOW_UP_DUE',
      'PROJECT_BEHIND_SCHEDULE',
      'STALE_ENQUIRY',
      'DOCUMENT_TO_REVIEW',
    ]) {
      expect(
        lines.some((l) => l.startsWith(`${kind} |`)),
        kind,
      ).toBe(true);
    }
    expect(
      lines.some((l) => l.includes('also FOLLOW_UP_DUE')),
      'a merged row',
    ).toBe(true);
    for (const section of ['overdue', 'dueToday', 'comingUp'] as const) {
      expect(
        Object.values(actual).some((s) => s[section].length > 0),
        section,
      ).toBe(true);
    }
  });
});
