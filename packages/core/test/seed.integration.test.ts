import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from '../auth/auth.ts';
import { disconnectAll, getDb } from '../clients.ts';
import { systemCtx, withTx } from '../context.ts';
import { todayInIST } from '../schemas/common.ts';
import { SYSTEM_USER_EMAIL, SeedError, seed } from '../system/seed.ts';

const options = {
  adminEmail: 'root@example.test',
  adminPassword: 'seed-admin-password',
  devUsers: false,
};

describe('AC8: seed (integration)', () => {
  beforeAll(() => resetDb(getDb()));
  afterAll(disconnectAll);

  it('is idempotent: one admin, one system user, admin password still works', async () => {
    await seed(options);
    await seed(options);

    const db = getDb();
    expect(await db.user.count({ where: { role: 'ADMIN', isSystem: false } })).toBe(1);
    expect(await db.user.count({ where: { isSystem: true } })).toBe(1);

    const result = await getAuth().api.signInEmail({
      body: { email: options.adminEmail, password: options.adminPassword },
    });
    expect(result.user.email).toBe(options.adminEmail);
  });

  it('creates the system user as a non-login ADMIN with no credential account', async () => {
    const system = await getDb().user.findUniqueOrThrow({
      where: { email: SYSTEM_USER_EMAIL },
      include: { accounts: true },
    });
    expect(system).toMatchObject({ role: 'ADMIN', isSystem: true, active: true });
    expect(system.accounts).toHaveLength(0);
  });

  it('never lets the system user sign in, even if a password is attached', async () => {
    const system = await getDb().user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } });
    const context = await getAuth().$context;
    const password = await context.password.hash('sneaky-system-password');
    // Audited write: must run inside withTx (fails closed otherwise).
    await withTx(await systemCtx(), () =>
      context.internalAdapter.linkAccount({
        userId: system.id,
        providerId: 'credential',
        accountId: system.id,
        password,
      }),
    );

    await expect(
      getAuth().api.signInEmail({
        body: { email: SYSTEM_USER_EMAIL, password: 'sneaky-system-password' },
      }),
    ).rejects.toThrow();
  });

  it('seeds dev users only when asked', async () => {
    const db = getDb();
    expect(await db.user.count({ where: { role: { not: 'ADMIN' } } })).toBe(0);
    await seed({ ...options, devUsers: true });
    expect(await db.user.count({ where: { role: 'SALES' } })).toBe(2);
    expect(await db.user.count({ where: { role: 'PROJECT_MANAGER' } })).toBe(1);
  });

  it('M4: dev seed adds a sample pipeline with every status and source, once', async () => {
    const db = getDb();
    await seed({ ...options, devUsers: true });
    const enquiries = await db.enquiry.findMany();
    expect(new Set(enquiries.map((e) => e.status))).toEqual(
      new Set(['IN_PROGRESS', 'CONVERTED', 'LOST']),
    );
    expect(new Set(enquiries.map((e) => e.source)).size).toBe(7);
    const audit = await db.auditLog.findMany({ where: { entityType: 'Enquiry' } });
    expect(audit.every((row) => row.source === 'system')).toBe(true);

    await seed({ ...options, devUsers: true });
    expect(await db.enquiry.count()).toBe(enquiries.length);
  });

  it('M5: dev seed adds follow-ups on every channel, with missed, due and future next dates', async () => {
    const db = getDb();
    const followUps = await db.followUp.findMany();
    expect(new Set(followUps.map((f) => f.channel)).size).toBe(6);
    expect(new Set(followUps.map((f) => f.entityType))).toEqual(
      new Set(['CLIENT', 'ENQUIRY', 'QUOTATION', 'PROJECT', 'PURCHASE_ORDER', 'INVOICE']),
    );

    const today = todayInIST().getTime();
    const next = followUps.flatMap((f) =>
      f.nextFollowUpDate ? [f.nextFollowUpDate.getTime()] : [],
    );
    expect(next.some((t) => t < today)).toBe(true);
    expect(next.some((t) => t === today)).toBe(true);
    expect(next.some((t) => t > today)).toBe(true);

    // Authored by the enquiry owners (realistic timeline), audited as `system`.
    const system = await db.user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } });
    expect(followUps.every((f) => f.userId !== system.id)).toBe(true);
    const audit = await db.auditLog.findMany({ where: { entityType: 'FollowUp' } });
    expect(audit).toHaveLength(followUps.length);
    expect(audit.every((row) => row.source === 'system')).toBe(true);

    await seed({ ...options, devUsers: true });
    expect(await db.followUp.count()).toBe(followUps.length);
  });

  it('M5: a database seeded before M5 (enquiries, no follow-ups) gets the sample follow-ups', async () => {
    const db = getDb();
    const before = await db.followUp.count();
    // Test-only reset of the fixture: follow_up is soft-delete only in app code.
    await db.$executeRawUnsafe('DELETE FROM "follow_up"');
    await seed({ ...options, devUsers: true });
    expect(await db.followUp.count()).toBe(before);
  });

  it('M6: dev seed adds quotations in every status, INR and USD, above 32-bit amounts, once', async () => {
    const db = getDb();
    const quotations = await db.quotation.findMany();
    expect(new Set(quotations.map((q) => q.status))).toEqual(
      new Set(['SENT', 'UNDER_NEGOTIATION', 'PO_RECEIVED', 'LOST']),
    );
    expect(new Set(quotations.map((q) => q.currency))).toEqual(new Set(['INR', 'USD']));
    expect(quotations.some((q) => q.amountMinor > 2_147_483_647n)).toBe(true);
    const settings = await db.companySettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(settings.enabledCurrencies).toContain('USD');

    // Highlights come from the real follow-up sync; open ones have missed, due and future dates.
    expect(quotations.some((q) => q.lastFollowUpId !== null)).toBe(true);
    const today = todayInIST().getTime();
    const open = quotations
      .filter((q) => q.status === 'SENT' || q.status === 'UNDER_NEGOTIATION')
      .map((q) => q.nextFollowUpDate!.getTime());
    expect(open.some((t) => t < today)).toBe(true);
    expect(open.some((t) => t === today)).toBe(true);
    expect(open.some((t) => t > today)).toBe(true);
    const audit = await db.auditLog.findMany({ where: { entityType: 'Quotation' } });
    expect(audit.every((row) => row.source === 'system')).toBe(true);

    await seed({ ...options, devUsers: true });
    expect(await db.quotation.count()).toBe(quotations.length);
  });

  it('M6: a database seeded before M6 (no quotations) gets the sample quotations and their follow-ups', async () => {
    const db = getDb();
    const quotations = await db.quotation.count();
    const followUps = await db.followUp.count();
    // Test-only reset of the fixture: quotations are soft-delete only in app code. POs (M9)
    // and projects (M8) point at quotations, so they go first; the seed recreates them all.
    await db.$executeRawUnsafe(
      `DELETE FROM "follow_up" WHERE "entityType" IN ('QUOTATION', 'PROJECT', 'PURCHASE_ORDER', 'INVOICE')`,
    );
    await db.$executeRawUnsafe('DELETE FROM "invoice"');
    await db.$executeRawUnsafe('DELETE FROM "purchase_order_service"');
    await db.$executeRawUnsafe('DELETE FROM "purchase_order"');
    await db.$executeRawUnsafe('DELETE FROM "project_service"');
    await db.$executeRawUnsafe('DELETE FROM "project"');
    await db.$executeRawUnsafe('DELETE FROM "quotation_service"');
    await db.$executeRawUnsafe('DELETE FROM "quotation"');
    await seed({ ...options, devUsers: true });
    expect(await db.quotation.count()).toBe(quotations);
    expect(await db.followUp.count()).toBe(followUps);
  });

  it('M8: dev seed adds projects in every status, one unassigned and one behind schedule, once', async () => {
    const db = getDb();
    const projects = await db.project.findMany({ include: { manager: true } });
    expect(new Set(projects.map((p) => p.status))).toEqual(
      new Set(['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED']),
    );
    expect(projects.some((p) => p.managerId === null)).toBe(true);
    expect(
      projects.filter((p) => p.managerId).every((p) => p.manager?.email === 'pm@example.com'),
    ).toBe(true);
    const today = todayInIST().getTime();
    expect(
      projects.some(
        (p) =>
          ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD'].includes(p.status) &&
          p.endDate &&
          p.endDate.getTime() < today,
      ),
    ).toBe(true);
    expect(projects.find((p) => p.status === 'ON_HOLD')?.holdReason).toBeTruthy();
    expect(projects.find((p) => p.status === 'CANCELLED')?.cancelReason).toBeTruthy();
    expect(projects.find((p) => p.status === 'COMPLETED')?.completionPct).toBe(100);

    // At least one PO_RECEIVED quotation is left for the create flow.
    const waiting = await db.quotation.count({
      where: { status: 'PO_RECEIVED', projects: { none: { deletedAt: null } } },
    });
    expect(waiting).toBeGreaterThanOrEqual(1);
    expect(await db.followUp.count({ where: { entityType: 'PROJECT' } })).toBeGreaterThanOrEqual(1);

    const audit = await db.auditLog.findMany({ where: { entityType: 'Project' } });
    expect(audit.every((row) => row.source === 'system')).toBe(true);

    await seed({ ...options, devUsers: true });
    expect(await db.project.count()).toBe(projects.length);
  });

  it('M9: dev seed adds POs once, with a two-PO project over revenue and a live project without', async () => {
    const db = getDb();
    const pos = await db.purchaseOrder.findMany({ include: { project: true } });
    expect(pos.length).toBeGreaterThanOrEqual(5);
    expect(pos.every((po) => po.clientId === po.project.clientId)).toBe(true);
    expect(pos.some((po) => po.project.status === 'CANCELLED')).toBe(false);

    const byProject = new Map<string, typeof pos>();
    for (const po of pos) byProject.set(po.projectId, [...(byProject.get(po.projectId) ?? []), po]);
    const overRevenue = [...byProject.values()].filter(
      (list) =>
        list.length === 2 &&
        list
          .filter((po) => po.currency === po.project.currency)
          .reduce((sum, po) => sum + po.amountMinor, 0n) > list[0]!.project.revenueMinor,
    );
    expect(overRevenue).toHaveLength(1);

    const withoutPo = await db.project.count({
      where: { status: { not: 'CANCELLED' }, purchaseOrders: { none: { deletedAt: null } } },
    });
    expect(withoutPo).toBeGreaterThanOrEqual(1);
    expect(pos.some((po) => po.paymentTerms && po.paymentTermsDays === null)).toBe(true);
    expect(pos.some((po) => po.paymentTermsDays === 45)).toBe(true);

    const followUp = await db.followUp.findFirst({
      where: { entityType: 'PURCHASE_ORDER' },
      include: { user: true },
    });
    expect(followUp?.user.email).toBe('pm@example.com');
    const audit = await db.auditLog.findMany({
      where: { entityType: { in: ['PurchaseOrder', 'PurchaseOrderService'] } },
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((row) => row.source === 'system')).toBe(true);

    await seed({ ...options, devUsers: true });
    expect(await db.purchaseOrder.count()).toBe(pos.length);
  });

  it('M9: a database seeded before M9 (projects, no POs) gets the sample POs', async () => {
    const db = getDb();
    const pos = await db.purchaseOrder.count();
    const projects = await db.project.count();
    const followUps = await db.followUp.count();
    // Test-only reset of the fixture: POs are soft-delete only in app code.
    await db.$executeRawUnsafe(
      `DELETE FROM "follow_up" WHERE "entityType" IN ('PURCHASE_ORDER', 'INVOICE')`,
    );
    await db.$executeRawUnsafe('DELETE FROM "invoice"');
    await db.$executeRawUnsafe('DELETE FROM "purchase_order_service"');
    await db.$executeRawUnsafe('DELETE FROM "purchase_order"');
    await seed({ ...options, devUsers: true });
    expect(await db.purchaseOrder.count()).toBe(pos);
    expect(await db.project.count()).toBe(projects);
    expect(await db.followUp.count()).toBe(followUps);
  });

  it('M10 (AC12): dev seed adds invoices once, with POs PAID, PENDING (part-paid) and OVERDUE', async () => {
    const db = getDb();
    const invoices = await db.invoice.findMany();
    expect(invoices.length).toBeGreaterThanOrEqual(4);
    expect(invoices.every((i) => i.currency === 'INR' || i.currency === 'USD')).toBe(true);

    const pos = await db.purchaseOrder.findMany({
      include: { invoices: { where: { deletedAt: null } } },
    });
    const byNumber = new Map(pos.map((po) => [po.poNumber, po]));
    const paid = byNumber.get('EXP-PO-8812')!;
    expect(paid.status).toBe('PAID');
    const partPaid = byNumber.get('4500012345')!;
    expect(partPaid.status).toBe('PENDING');
    expect(partPaid.invoices).toMatchObject([{ status: 'PAID', dueDateBasis: 'PO_TERMS' }]);
    const overdue = byNumber.get('WH-2026-114')!;
    expect(overdue.status).toBe('OVERDUE');
    expect(overdue.invoices).toMatchObject([{ status: 'OVERDUE' }]);
    const dueSoon = byNumber.get('PO/SOP/2026/07')!.invoices[0]!;
    expect(dueSoon).toMatchObject({ status: 'PENDING', dueDateBasis: 'COMPANY_DEFAULT' });
    expect(dueSoon.dueDate.getTime() - todayInIST().getTime()).toBe(3 * 86_400_000);
    expect(byNumber.get('WH-2026-131')!.invoices).toEqual([]);

    const followUp = await db.followUp.findFirst({
      where: { entityType: 'INVOICE', entityId: overdue.invoices[0]!.id },
      include: { user: true },
    });
    expect(followUp?.user.email).toBe('pm@example.com');
    const audit = await db.auditLog.findMany({ where: { entityType: 'Invoice' } });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((row) => row.source === 'system')).toBe(true);

    await seed({ ...options, devUsers: true });
    expect(await db.invoice.count()).toBe(invoices.length);
  });

  it('M10: a database seeded before M10 (POs, no invoices) gets the sample invoices', async () => {
    const db = getDb();
    const invoices = await db.invoice.count();
    const followUps = await db.followUp.count();
    // Test-only reset of the fixture: invoices are soft-delete only in app code.
    await db.$executeRawUnsafe(`DELETE FROM "follow_up" WHERE "entityType" = 'INVOICE'`);
    await db.$executeRawUnsafe('DELETE FROM "invoice"');
    await seed({ ...options, devUsers: true });
    expect(await db.invoice.count()).toBe(invoices);
    expect(await db.followUp.count()).toBe(followUps);
  });

  it('fails clearly when the admin credentials are missing', async () => {
    await expect(seed({ ...options, adminEmail: undefined })).rejects.toThrow(SeedError);
    await expect(seed({ ...options, adminPassword: undefined })).rejects.toThrow(
      /SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD/,
    );
  });

  it('AC12: audits every seeded User and Account row as the system user', async () => {
    const db = getDb();
    const system = await db.user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } });
    const users = await db.user.findMany({ select: { id: true } });
    const accounts = await db.account.findMany({
      where: { providerId: 'credential', password: { not: null } },
      select: { id: true, userId: true },
    });
    // The account linked by hand in the "sneaky password" test above was written under
    // a test ctx; every seeded account belongs to a non-system user.
    const seededAccounts = accounts.filter((a) => a.userId !== system.id);
    for (const { id } of [...users, ...seededAccounts]) {
      const create = await db.auditLog.findFirst({ where: { entityId: id, action: 'CREATE' } });
      expect(create, `CREATE audit row for ${id}`).not.toBeNull();
      expect(create?.source).toBe('system');
      expect(create?.actorId).toBe(system.id);
    }
  });

  it('AC12: the system user’s own CREATE row names itself as the actor', async () => {
    const system = await getDb().user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } });
    const row = await getDb().auditLog.findFirstOrThrow({
      where: { entityType: 'User', entityId: system.id, action: 'CREATE' },
    });
    expect(row.actorId).toBe(system.id);
  });
});

// Code-review fix: the sample pipeline is all-or-nothing. It is skipped once any enquiry
// exists, so a failure part-way must not leave some behind.
describe('M4: dev seed sample pipeline after a failure', () => {
  beforeAll(() => resetDb(getDb()));
  afterAll(disconnectAll);

  it('leaves no sample data behind, so the next seed completes', async () => {
    const db = getDb();
    await seed(options);
    // A soft-deleted "Training" service: masters count it as present, but the fourth
    // sample enquiry cannot use it, so seeding fails after three enquiries.
    const training = await withTx(await systemCtx(), (tx) =>
      tx.service.create({ data: { name: 'Training', deletedAt: new Date() } }),
    );

    await expect(seed({ ...options, devUsers: true })).rejects.toThrow(/Training/);
    expect(await db.enquiry.count({ where: { deletedAt: undefined } })).toBe(0);
    expect(await db.client.count({ where: { deletedAt: undefined } })).toBe(0);

    await withTx(await systemCtx(), (tx) =>
      tx.service.update({ where: { id: training.id }, data: { deletedAt: null } }),
    );
    await seed({ ...options, devUsers: true });
    const statuses = await db.enquiry.findMany({ select: { status: true } });
    // The eight M4 samples, M11's two stale enquiries and M12's ageing pipeline.
    expect(statuses).toHaveLength(11);
    expect(new Set(statuses.map((e) => e.status))).toEqual(
      new Set(['IN_PROGRESS', 'CONVERTED', 'LOST']),
    );
  });
});
