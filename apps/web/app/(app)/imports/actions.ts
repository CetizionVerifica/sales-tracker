'use server';

import {
  commitImportBatch,
  editImportRow,
  setImportRowsExcluded,
  undoImportBatch,
  updateImportMapping,
  updateImportValueMapping,
} from '@sales-tracker/core';
import {
  commitImportBatchSchema,
  editImportRowSchema,
  setImportRowsExcludedSchema,
  undoImportBatchSchema,
  updateColumnMappingSchema,
  updateValueMappingSchema,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

function refresh(batchId: string) {
  revalidatePath(`/imports/${batchId}`);
  revalidatePath('/imports');
}

export const updateImportMappingAction = action(updateColumnMappingSchema, async (ctx, input) => {
  const batch = await updateImportMapping(ctx, input);
  refresh(batch.id);
  return { id: batch.id };
});

export const updateImportValueMappingAction = action(
  updateValueMappingSchema,
  async (ctx, input) => {
    const batch = await updateImportValueMapping(ctx, input);
    refresh(batch.id);
    return { id: batch.id };
  },
);

export const editImportRowAction = action(editImportRowSchema, async (ctx, input) => {
  const row = await editImportRow(ctx, input);
  return { id: row.id };
});

export const setImportRowsExcludedAction = action(
  setImportRowsExcludedSchema,
  async (ctx, input) => {
    await setImportRowsExcluded(ctx, input);
    return { ok: true };
  },
);

export const commitImportBatchAction = action(commitImportBatchSchema, async (ctx, input) => {
  const batch = await commitImportBatch(ctx, input);
  refresh(batch.id);
  return { id: batch.id };
});

export const undoImportBatchAction = action(undoImportBatchSchema, async (ctx, input) => {
  const result = await undoImportBatch(ctx, input);
  refresh(input.id);
  return result;
});
