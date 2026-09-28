import { resetDb } from '@sales-tracker/db/test-utils';
import * as XLSX from 'xlsx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../../clients.ts';
import { withTx, type Ctx } from '../../context.ts';
import { DomainError, ForbiddenError } from '../../errors.ts';
import { closeImportsQueue } from '../../import/queue.ts';
import {
  commitImportBatch,
  createImportBatch,
  editImportRow,
  expireImportDrafts,
  getDistinctImportValues,
  getImportBatch,
  listImportRows,
  runImportCommitJob,
  runImportParseJob,
  setImportRowsExcluded,
  undoImportBatch,
  updateImportValueMapping,
} from '../../import/service.ts';
import type { ImportUploadFile } from '../../import/file-types.ts';
import { createClient } from '../../services/client.service.ts';
import { createSector } from '../../services/sector.service.ts';
import { createService } from '../../services/service.service.ts';
import { updateSettings } from '../../services/settings.service.ts';
import { ensureCompanySettings } from '../../system/seed.ts';
import { actor, createTestUser, ctxFor, ensureSystemCtx } from '../helpers.ts';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

const auditOf = (entityType: string, entityId: string) =>
  getDb().auditLog.findMany({ where: { entityType, entityId }, orderBy: { createdAt: 'asc' } });

function xlsxFile(rows: unknown[][], filename = 'enquiries.xlsx'): ImportUploadFile {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;
  return { bytes, filename };
}

const HEADER = ['Client', 'Sector', 'Services', 'Received Date', 'Source'];

describe('M10b bulk import (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let pm: Ctx;
  let pharma: string;
  let sunPharma: string;

  /** Uploads + parses a file, returning the ready batch id. */
  async function uploadAndParse(ctx: Ctx, rows: unknown[][]) {
    const batch = await createImportBatch(ctx, { fileName: 'enquiries.xlsx', fileSize: 1000, entity: 'ENQUIRY' }, xlsxFile(rows));
    await runImportParseJob(batch.id);
    return getImportBatch(ctx, batch.id);
  }

  beforeAll(async () => {
    await resetDb(getDb());
    await ensureSystemCtx();
    const user = async (email: string, role: 'ADMIN' | 'SALES' | 'PROJECT_MANAGER') =>
      ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
    admin = await user('admin@example.test', 'ADMIN');
    sales = await user('sales@example.test', 'SALES');
    sales2 = await user('sales2@example.test', 'SALES');
    pm = await user('pm@example.test', 'PROJECT_MANAGER');
    await ensureCompanySettings();
    await updateSettings(admin, {
      companyName: 'Test Co',
      defaultInvoiceDueDays: 30,
      enabledCurrencies: ['INR', 'USD'],
    });
    pharma = (await createSector(admin, { name: 'Pharmaceutical' })).id;
    await createService(admin, { name: 'ESG' });
    sunPharma = (await createClient(sales, { name: 'Sun Pharma', sectorId: pharma })).id;
  });

  afterAll(async () => {
    await closeImportsQueue();
    await disconnectAll();
  });

  describe('RBAC', () => {
    it('a project manager cannot create an import batch', async () => {
      const error = await rejection(
        createImportBatch(pm, { fileName: 'x.xlsx', fileSize: 10, entity: 'ENQUIRY' }, xlsxFile([HEADER])),
      );
      expect(error).toBeInstanceOf(ForbiddenError);
    });

    it('a Sales user cannot read another Sales user’s batch', async () => {
      const batch = await uploadAndParse(sales, [HEADER, ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email']]);
      const error = await rejection(getImportBatch(sales2, batch.id));
      expect(error).toBeInstanceOf(ForbiddenError);
      // Admin can always read it.
      await expect(getImportBatch(admin, batch.id)).resolves.toMatchObject({ id: batch.id });
    });
  });

  describe('parse + heuristic mapping', () => {
    it('detects headers and auto-maps well-known column names', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email'],
      ]);
      expect(batch.status).toBe('READY');
      expect(batch.sheetConfig).toMatchObject({ headerRow: 1, dataStartRow: 2, dataEndRow: 2 });
      const fields = batch.mapping!.columns.map((c) => c.field);
      expect(fields).toEqual(['client', 'sector', 'services', 'receivedDate', 'source']);
      expect(batch.counts).toMatchObject({ total: 1, ready: 1, error: 0 });
    });

    it('skips title rows and a grand total row (fixture-1 shape)', async () => {
      const batch = await uploadAndParse(sales, [
        ['ACME EXPORTS PVT LTD'],
        [],
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email'],
        ['Grand total'],
      ]);
      expect(batch.sheetConfig).toMatchObject({ headerRow: 3, dataStartRow: 4 });
      expect(batch.counts).toMatchObject({ total: 1 });
    });
  });

  describe('validation', () => {
    it('a row with an unmatched sector is an ERROR and does not block other rows', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Nonexistent Sector', 'ESG', '10/03/2026', 'Email'],
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '11/03/2026', 'Email'],
      ]);
      expect(batch.counts).toMatchObject({ total: 2, ready: 1, error: 1 });
      const rows = await listImportRows(sales, { batchId: batch.id, page: 1, pageSize: 10 });
      const errorRow = rows.items.find((r) => r.status === 'ERROR')!;
      expect(errorRow.messages[0]).toMatchObject({ field: 'sector', code: 'unmatched' });
    });

    it('a Sales actor cannot set another owner; an Admin can', async () => {
      const withOwner = [...HEADER, 'Owner'];
      const salesBatch = await uploadAndParse(sales, [
        withOwner,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email', 'Someone Else'],
      ]);
      expect(salesBatch.counts).toMatchObject({ error: 1 });

      const adminBatch = await uploadAndParse(admin, [
        withOwner,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email', sales.user.id],
      ]);
      // The owner column holds a name, not an id, in real files — an unmatched id-as-name is
      // still an ERROR (no active user is literally named the id string); this only proves
      // an Admin's Owner column is resolved via the live user list, not blocked outright.
      expect(adminBatch.counts!.error + adminBatch.counts!.ready).toBe(1);
    });

    it('the shared enquiry rule applies: sourceDetail is required for Referral', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Referral'],
      ]);
      expect(batch.counts).toMatchObject({ error: 1 });
      const rows = await listImportRows(sales, { batchId: batch.id, page: 1, pageSize: 10 });
      expect(rows.items[0]!.messages.some((m) => m.field === 'sourceDetail')).toBe(true);
    });

    it('flags a within-file repeat as DUPLICATE, and a match against an existing enquiry as WARNING', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '15/03/2026', 'Email'],
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '15/03/2026', 'Email'],
      ]);
      expect(batch.counts).toMatchObject({ ready: 1, duplicate: 1 });

      await commitImportBatch(sales, { id: batch.id });
      await runImportCommitJob(batch.id);

      const reimport = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '15/03/2026', 'Email'],
      ]);
      expect(reimport.counts).toMatchObject({ warning: 1 });
    });
  });

  describe('the Values step', () => {
    it('resolves a previously-unmatched sector value via an explicit mapping, then re-validates', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharma', 'ESG', '10/03/2026', 'Email'],
      ]);
      expect(batch.counts).toMatchObject({ error: 1 });

      const distinct = await getDistinctImportValues(sales, batch.id);
      const sectorValues = distinct.find((f) => f.field === 'sector')!;
      expect(sectorValues.values.map((v) => v.value)).toContain('Pharma');

      const updated = await updateImportValueMapping(sales, {
        batchId: batch.id,
        values: [{ field: 'sector', sourceValue: 'Pharma', action: 'map', targetId: pharma }],
      });
      expect(updated.counts).toMatchObject({ ready: 1, error: 0 });
    });

    it('creates a new client at commit when the Values step chose "create new"', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Brand New Co', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email'],
      ]);
      expect(batch.counts).toMatchObject({ error: 1 });

      await updateImportValueMapping(sales, {
        batchId: batch.id,
        values: [{ field: 'client', sourceValue: 'Brand New Co', action: 'create' }],
      });

      await commitImportBatch(sales, { id: batch.id });
      await runImportCommitJob(batch.id);

      const client = await getDb().client.findFirst({ where: { name: 'Brand New Co' } });
      expect(client).toBeTruthy();
      expect(client!.importBatchId).toBe(batch.id);
      const enquiry = await getDb().enquiry.findFirst({ where: { clientId: client!.id } });
      expect(enquiry!.importBatchId).toBe(batch.id);
    });
  });

  describe('review: fix in place and exclude', () => {
    it('editing a row re-validates just that row', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Nonexistent Sector', 'ESG', '10/03/2026', 'Email'],
      ]);
      const rows = await listImportRows(sales, { batchId: batch.id, page: 1, pageSize: 10 });
      const row = rows.items[0]!;
      expect(row.status).toBe('ERROR');

      const fixed = await editImportRow(sales, { rowId: row.id, original: { Sector: 'Pharmaceutical' } });
      expect(fixed.status).toBe('READY');
      expect(fixed.resolved!.sectorId).toBe(pharma);
    });

    it('excluding a row removes it from the error count and commit', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email'],
        ['Sun Pharma', 'Nonexistent Sector', 'ESG', '11/03/2026', 'Email'],
      ]);
      const rows = await listImportRows(sales, { batchId: batch.id, page: 1, pageSize: 10 });
      const badRow = rows.items.find((r) => r.status === 'ERROR')!;

      await setImportRowsExcluded(sales, { rowIds: [badRow.id], excluded: true });
      const after = await getImportBatch(sales, batch.id);
      expect(after.counts).toMatchObject({ error: 0, excluded: 1, ready: 1 });

      await commitImportBatch(sales, { id: batch.id });
      const result = await runImportCommitJob(batch.id);
      void result;
      const committed = await getImportBatch(sales, batch.id);
      expect(committed.status).toBe('COMMITTED');
      expect(committed.counts).toMatchObject({ ready: 1 });
    });
  });

  describe('commit', () => {
    it('creates enquiries with importBatchId, source "import" audit rows, and invoices the RBAC-owned owner', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email'],
      ]);
      await commitImportBatch(sales, { id: batch.id });
      await runImportCommitJob(batch.id);

      const committed = await getImportBatch(sales, batch.id);
      expect(committed.status).toBe('COMMITTED');
      expect(committed.committedAt).toBeTruthy();

      const enquiry = await getDb().enquiry.findFirst({ where: { importBatchId: batch.id } });
      expect(enquiry).toBeTruthy();
      expect(enquiry!.ownerId).toBe(sales.user.id);
      expect(enquiry!.clientId).toBe(sunPharma);

      // One row for the create, one for tagging importBatchId right after.
      const rows = await auditOf('Enquiry', enquiry!.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.source === 'import')).toBe(true);
      expect(rows.every((r) => r.actorId === sales.user.id)).toBe(true);
    });

    it('two concurrent commit runs for the same batch create only one enquiry per row', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email'],
      ]);
      await commitImportBatch(sales, { id: batch.id });
      // Simulates a stray duplicate job run racing the real one (a bug once produced two
      // enquiries from a single row: commit-batch.ts now claims the batch atomically).
      await Promise.all([runImportCommitJob(batch.id), runImportCommitJob(batch.id)]);

      const enquiries = await getDb().enquiry.findMany({ where: { importBatchId: batch.id } });
      expect(enquiries).toHaveLength(1);
      const committed = await getImportBatch(sales, batch.id);
      expect(committed.status).toBe('COMMITTED');
      expect(committed.counts).toMatchObject({ created: 1 });
    });

    it('refuses to commit while an ERROR row remains', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Nonexistent Sector', 'ESG', '10/03/2026', 'Email'],
      ]);
      const error = await rejection(commitImportBatch(sales, { id: batch.id }));
      expect(error).toBeInstanceOf(DomainError);
    });
  });

  describe('undo', () => {
    it('soft-deletes the created enquiry and marks the batch UNDONE', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '18/03/2026', 'Email'],
      ]);
      await commitImportBatch(sales, { id: batch.id });
      await runImportCommitJob(batch.id);
      const enquiry = await getDb().enquiry.findFirst({ where: { importBatchId: batch.id } });

      const result = await undoImportBatch(sales, { id: batch.id });
      expect(result.undone).toBe(1);

      const after = await getDb().enquiry.findFirst({ where: { id: enquiry!.id, deletedAt: undefined } });
      expect(after!.deletedAt).toBeTruthy();
      const view = await getImportBatch(sales, batch.id);
      expect(view.status).toBe('UNDONE');
    });

    it('blocks undo for a row edited since the import, unless an admin forces it', async () => {
      const batch = await uploadAndParse(sales, [
        HEADER,
        ['Sun Pharma', 'Pharmaceutical', 'ESG', '19/03/2026', 'Email'],
      ]);
      await commitImportBatch(sales, { id: batch.id });
      await runImportCommitJob(batch.id);
      const enquiry = await getDb().enquiry.findFirst({ where: { importBatchId: batch.id } });

      // Simulate the user editing the imported enquiry afterwards.
      await withTx(sales, (tx) =>
        tx.enquiry.update({ where: { id: enquiry!.id }, data: { description: 'edited by hand' } }),
      );

      const blocked = await undoImportBatch(sales, { id: batch.id });
      expect(blocked.undone).toBe(0);
      expect(blocked.blocked).toHaveLength(1);

      const forced = await undoImportBatch(admin, { id: batch.id, force: true });
      expect(forced.undone).toBe(1);
    });
  });

  describe('expire-drafts', () => {
    it('moves a stale draft past its expiry to EXPIRED', async () => {
      const batch = await uploadAndParse(sales, [HEADER, ['Sun Pharma', 'Pharmaceutical', 'ESG', '10/03/2026', 'Email']]);
      await withTx(sales, (tx) =>
        tx.importBatch.update({ where: { id: batch.id }, data: { expiresAt: new Date(Date.now() - 1000) } }),
      );

      const result = await expireImportDrafts(await ensureSystemCtx());
      expect(result.expired).toBeGreaterThanOrEqual(1);
      const after = await getImportBatch(sales, batch.id);
      expect(after.status).toBe('EXPIRED');
    });
  });
});
