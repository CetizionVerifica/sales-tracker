import { assertCan, withTx, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import type { Page } from '../schemas/common.ts';
import {
  createSectorSchema,
  updateSectorSchema,
  type CreateSectorInput,
  type ListMastersInput,
  type UpdateSectorInput,
} from '../schemas/master.ts';
import type { Db } from '../clients.ts';
import { createMasterService, type MasterRow } from './master-factory.ts';
import { guardUnique, nameEquals } from './unique.ts';

/*
 * Sectors share the M3 master lifecycle (list, get, deactivate, soft delete, restore,
 * options) but add `isOther` (M12b), so create/update are written here instead of through
 * the shared factory; every other method is the factory's, unchanged.
 */

export interface SectorRow extends MasterRow {
  isOther: boolean;
}

const sectors = createMasterService('sector', 'Sector');
const duplicate = (name: string) => `A sector named “${name}” already exists`;

export const listSectors = sectors.list as (
  ctx: Ctx,
  input: ListMastersInput,
) => Promise<Page<SectorRow>>;
export const getSector = sectors.get as (ctx: Ctx, id: string) => Promise<SectorRow>;
export const softDeleteSector = sectors.softDelete as (ctx: Ctx, id: string) => Promise<SectorRow>;
export const restoreSector = sectors.restore as (ctx: Ctx, id: string) => Promise<SectorRow>;
export const listSectorOptions = sectors.options;

async function assertNameFree(db: Db, name: string, excludeId?: string) {
  const clash = await db.sector.findFirst({
    where: { name: nameEquals(name), ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new DomainError(duplicate(name), { field: 'name' });
}

export async function createSector(ctx: Ctx, input: CreateSectorInput): Promise<SectorRow> {
  const data = createSectorSchema.parse(input);
  assertCan(ctx, 'create', 'master');
  return withTx(ctx, async (tx) => {
    await assertNameFree(tx, data.name);
    return guardUnique('name', duplicate(data.name), () => tx.sector.create({ data }));
  });
}

export async function updateSector(
  ctx: Ctx,
  id: string,
  input: UpdateSectorInput,
): Promise<SectorRow> {
  const data = updateSectorSchema.parse(input);
  assertCan(ctx, 'update', 'master');
  return withTx(ctx, async (tx) => {
    const row = await tx.sector.findFirst({ where: { id } });
    if (!row) throw new NotFoundError('sector');
    if (data.name) await assertNameFree(tx, data.name, id);
    return guardUnique('name', duplicate(data.name ?? ''), () =>
      tx.sector.update({ where: { id }, data }),
    );
  });
}
