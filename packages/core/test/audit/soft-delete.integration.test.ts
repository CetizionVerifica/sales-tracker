import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../../clients.ts';
import { withTx, type Ctx } from '../../context.ts';
import { SoftDeleteError } from '../../errors.ts';
import { getClient, removeContact } from '../../services/client.service.ts';
import { actor, createTestUser, ctxFor } from '../helpers.ts';

describe('AC9: soft-delete extension (integration)', () => {
  let admin: Ctx;
  let liveId: string;
  let deletedId: string;

  beforeAll(async () => {
    await resetDb(getDb());
    admin = ctxFor(
      actor('ADMIN', { id: (await createTestUser('admin@example.test', 'ADMIN')).id }),
    );
    await withTx(admin, async (tx) => {
      liveId = (await tx.sector.create({ data: { name: 'Live' } })).id;
      deletedId = (await tx.sector.create({ data: { name: 'Gone' } })).id;
      await tx.sector.update({ where: { id: deletedId }, data: { deletedAt: new Date() } });
    });
  });
  afterAll(disconnectAll);

  it('hides soft-deleted rows from findMany, findFirst, findUnique and count', async () => {
    const db = getDb();
    expect((await db.sector.findMany()).map((s) => s.id)).toEqual([liveId]);
    expect(await db.sector.findFirst({ where: { name: 'Gone' } })).toBeNull();
    expect(await db.sector.findUnique({ where: { id: deletedId } })).toBeNull();
    expect(await db.sector.count()).toBe(1);
  });

  it('returns them when the query mentions deletedAt (explicit opt-in)', async () => {
    const deleted = await getDb().sector.findMany({ where: { deletedAt: { not: null } } });
    expect(deleted.map((s) => s.id)).toEqual([deletedId]);
    expect(await getDb().sector.count({ where: { deletedAt: undefined } })).toBe(2);
  });

  it('rejects hard deletes on soft-deletable models', async () => {
    await expect(
      withTx(admin, (tx) => tx.sector.delete({ where: { id: liveId } })),
    ).rejects.toBeInstanceOf(SoftDeleteError);
    await expect(withTx(admin, (tx) => tx.sector.deleteMany({}))).rejects.toBeInstanceOf(
      SoftDeleteError,
    );
    expect(await getDb().sector.count({ where: { deletedAt: undefined } })).toBe(2);
  });

  it('still audits soft delete and restore with full before/after rows', async () => {
    const rows = await getDb().auditLog.findMany({
      where: { entityId: deletedId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'SOFT_DELETE']);
    expect(rows[1]?.before).toMatchObject({ deletedAt: null });

    await withTx(admin, (tx) =>
      tx.sector.update({ where: { id: deletedId }, data: { deletedAt: null } }),
    );
    const restore = await getDb().auditLog.findFirstOrThrow({
      where: { entityId: deletedId, action: 'RESTORE' },
    });
    expect(restore.after).toMatchObject({ name: 'Gone', deletedAt: null });
  });

  it('documents the include limit: services filter nested relations themselves', async () => {
    const client = await withTx(admin, async (tx) => {
      const c = await tx.client.create({ data: { name: 'Acme', sectorId: liveId } });
      await tx.clientContact.create({ data: { clientId: c.id, name: 'Kept' } });
      await tx.clientContact.create({ data: { clientId: c.id, name: 'Removed' } });
      return c;
    });
    const removed = await getDb().clientContact.findFirstOrThrow({ where: { name: 'Removed' } });
    await removeContact(admin, removed.id);

    const raw = await getDb().client.findUniqueOrThrow({
      where: { id: client.id },
      include: { contacts: true },
    });
    expect(raw.contacts).toHaveLength(2); // include is not filtered by the extension
    expect((await getClient(admin, client.id)).contacts.map((c) => c.name)).toEqual(['Kept']);
  });
});
