import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { ForbiddenError } from '../errors.ts';
import { getSettings, updateSettings } from '../services/settings.service.ts';
import { ensureCompanySettings } from '../system/seed.ts';
import { actor, createTestUser, ctxFor, ensureSystemCtx } from './helpers.ts';

const valid = {
  companyName: 'Acme Certifications',
  defaultInvoiceDueDays: 45,
  enabledCurrencies: ['INR', 'USD'],
};

describe('AC14: company settings (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let pm: Ctx;

  beforeAll(async () => {
    await resetDb(getDb());
    await ensureSystemCtx();
    await ensureCompanySettings();
    await ensureCompanySettings(); // idempotent
    admin = ctxFor(
      actor('ADMIN', { id: (await createTestUser('admin@example.test', 'ADMIN')).id }),
    );
    sales = ctxFor(
      actor('SALES', { id: (await createTestUser('sales@example.test', 'SALES')).id }),
    );
    pm = ctxFor(
      actor('PROJECT_MANAGER', {
        id: (await createTestUser('pm@example.test', 'PROJECT_MANAGER')).id,
      }),
    );
  });
  afterAll(disconnectAll);

  it('starts with the defaults and is readable by every role', async () => {
    for (const ctx of [admin, sales, pm]) {
      expect(await getSettings(ctx)).toMatchObject({
        defaultInvoiceDueDays: 30,
        enabledCurrencies: ['INR'],
        baseCurrency: 'INR',
      });
    }
  });

  it('lets admins update, audited', async () => {
    const updated = await updateSettings(admin, valid);
    expect(updated).toMatchObject(valid);
    const row = await getDb().auditLog.findFirstOrThrow({
      where: { entityType: 'CompanySettings', action: 'UPDATE' },
    });
    expect(row.changedFields).toEqual([
      'companyName',
      'defaultInvoiceDueDays',
      'enabledCurrencies',
    ]);
    expect(row.actorId).toBe(admin.user.id);
  });

  it('forbids non-admins from updating', async () => {
    await expect(updateSettings(sales, valid)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateSettings(pm, valid)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each([
    ['negative due days', { ...valid, defaultInvoiceDueDays: -1 }],
    ['due days over 365', { ...valid, defaultInvoiceDueDays: 366 }],
    ['fractional due days', { ...valid, defaultInvoiceDueDays: 1.5 }],
    ['a lower-case code', { ...valid, enabledCurrencies: ['INR', 'usd'] }],
    ['an unknown code', { ...valid, enabledCurrencies: ['INR', 'XYZ'] }],
    ['no INR', { ...valid, enabledCurrencies: ['USD'] }],
    ['duplicate codes', { ...valid, enabledCurrencies: ['INR', 'INR'] }],
    ['an empty company name', { ...valid, companyName: '  ' }],
    ['a base-currency change', { ...valid, baseCurrency: 'USD' }],
  ])('rejects %s', async (_label, input) => {
    await expect(updateSettings(admin, input as typeof valid)).rejects.toThrow();
    expect((await getSettings(admin)).baseCurrency).toBe('INR');
  });

  it('cannot hold a second row, even through raw SQL (CHECK constraint)', async () => {
    await expect(
      getDb().$executeRawUnsafe(
        `INSERT INTO company_settings (id, "companyName", "updatedAt") VALUES (2, 'Second', now())`,
      ),
    ).rejects.toThrow(/company_settings_singleton/);
  });
});
