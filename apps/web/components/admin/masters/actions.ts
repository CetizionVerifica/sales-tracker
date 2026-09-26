'use server';

import {
  createSector,
  createService,
  restoreSector,
  restoreService,
  softDeleteSector,
  softDeleteService,
  updateSector,
  updateService,
} from '@sales-tracker/core';
import {
  createMasterSchema,
  idOnlySchema,
  updateMasterSchema,
  withId,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { action } from '@/lib/action';

const kindSchema = z.enum(['sector', 'service']);
const ops = {
  sector: {
    create: createSector,
    update: updateSector,
    remove: softDeleteSector,
    restore: restoreSector,
  },
  service: {
    create: createService,
    update: updateService,
    remove: softDeleteService,
    restore: restoreService,
  },
};

function done<T>(kind: 'sector' | 'service', value: T): T {
  revalidatePath(`/admin/${kind}s`);
  return value;
}

export const createMasterAction = action(
  z.object({ kind: kindSchema, data: createMasterSchema }),
  async (ctx, { kind, data }) => done(kind, await ops[kind].create(ctx, data)),
);

export const updateMasterAction = action(
  withId(updateMasterSchema).extend({ kind: kindSchema }),
  async (ctx, { kind, id, data }) => done(kind, await ops[kind].update(ctx, id, data)),
);

export const deleteMasterAction = action(
  idOnlySchema.extend({ kind: kindSchema }),
  async (ctx, { kind, id }) => done(kind, await ops[kind].remove(ctx, id)),
);

export const restoreMasterAction = action(
  idOnlySchema.extend({ kind: kindSchema }),
  async (ctx, { kind, id }) => done(kind, await ops[kind].restore(ctx, id)),
);
