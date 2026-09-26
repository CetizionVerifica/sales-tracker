import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import type { Page } from '../schemas/common.ts';
import {
  createMasterSchema,
  listMastersSchema,
  updateMasterSchema,
  type CreateMasterInput,
  type ListMastersInput,
  type UpdateMasterInput,
} from '../schemas/master.ts';
import { guardUnique, nameEquals } from './unique.ts';

export interface MasterRow {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * The slice of the Sector/Service delegates used here. Both models share this shape; the
 * structural type avoids calling methods on a union of two Prisma delegates.
 */
interface MasterDelegate {
  findMany(args: object): Promise<MasterRow[]>;
  findFirst(args: object): Promise<MasterRow | null>;
  count(args: object): Promise<number>;
  create(args: object): Promise<MasterRow>;
  update(args: object): Promise<MasterRow>;
}

/**
 * Sectors and services share one lifecycle (M3): create, rename, (de)activate, soft delete,
 * restore, plus picker options. Everyone reads; only admins write (`master` in can()).
 */
export function createMasterService(model: 'sector' | 'service', label: string) {
  const table = (db: Db) => db[model] as unknown as MasterDelegate;
  const duplicate = (name: string) => `A ${label.toLowerCase()} named “${name}” already exists`;

  async function assertNameFree(db: Db, name: string, excludeId?: string) {
    const clash = await table(db).findFirst({
      where: { name: nameEquals(name), ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new DomainError(duplicate(name), { field: 'name' });
  }

  async function findLive(db: Db, id: string): Promise<MasterRow> {
    const row = await table(db).findFirst({ where: { id } });
    if (!row) throw new NotFoundError(model);
    return row;
  }

  return {
    async list(ctx: Ctx, input: ListMastersInput): Promise<Page<MasterRow>> {
      const { page, pageSize, q, sort, dir, status } = listMastersSchema.parse(input);
      assertCan(ctx, 'list', 'master');
      const where = {
        ...(status === 'active' && { active: true }),
        ...(status === 'inactive' && { active: false }),
        ...(status === 'deleted' && { deletedAt: { not: null } }),
        ...(q && { name: { contains: q, mode: 'insensitive' as const } }),
      };
      const [items, total] = await Promise.all([
        table(getDb()).findMany({
          where,
          orderBy: [{ [sort ?? 'name']: dir ?? 'asc' }, { id: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        table(getDb()).count({ where }),
      ]);
      return { items, total, page, pageSize };
    },

    /** Includes soft-deleted rows, so a restore view can show them. */
    async get(ctx: Ctx, id: string): Promise<MasterRow> {
      assertCan(ctx, 'read', 'master');
      const row = await table(getDb()).findFirst({ where: { id, deletedAt: undefined } });
      if (!row) throw new NotFoundError(model);
      return row;
    },

    async create(ctx: Ctx, input: CreateMasterInput): Promise<MasterRow> {
      const data = createMasterSchema.parse(input);
      assertCan(ctx, 'create', 'master');
      return withTx(ctx, async (tx) => {
        await assertNameFree(tx, data.name);
        return guardUnique('name', duplicate(data.name), () => table(tx).create({ data }));
      });
    },

    async update(ctx: Ctx, id: string, input: UpdateMasterInput): Promise<MasterRow> {
      const data = updateMasterSchema.parse(input);
      assertCan(ctx, 'update', 'master');
      return withTx(ctx, async (tx) => {
        await findLive(tx, id);
        if (data.name) await assertNameFree(tx, data.name, id);
        return guardUnique('name', duplicate(data.name ?? ''), () =>
          table(tx).update({ where: { id }, data }),
        );
      });
    },

    async softDelete(ctx: Ctx, id: string): Promise<MasterRow> {
      assertCan(ctx, 'delete', 'master');
      return withTx(ctx, async (tx) => {
        await findLive(tx, id);
        return table(tx).update({ where: { id }, data: { deletedAt: new Date() } });
      });
    },

    /** Fails with a name field error when a live row took the name meanwhile. */
    async restore(ctx: Ctx, id: string): Promise<MasterRow> {
      assertCan(ctx, 'update', 'master');
      return withTx(ctx, async (tx) => {
        const row = await table(tx).findFirst({ where: { id, deletedAt: { not: null } } });
        if (!row) throw new NotFoundError(model);
        await assertNameFree(tx, row.name, id);
        return guardUnique('name', duplicate(row.name), () =>
          table(tx).update({ where: { id }, data: { deletedAt: null } }),
        );
      });
    },

    /** Active, non-deleted rows for pickers (M4 forms). */
    async options(ctx: Ctx): Promise<{ id: string; name: string }[]> {
      assertCan(ctx, 'list', 'master');
      const rows = await table(getDb()).findMany({
        where: { active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      return rows.map(({ id, name }) => ({ id, name }));
    },
  };
}
