'use server';

import { searchRecords } from '@sales-tracker/core';
import { searchRecordsSchema } from '@sales-tracker/core/schemas';
import { action } from '@/lib/action';

/** ⌘K search: records the user can read, by number or name. */
export const searchRecordsAction = action(searchRecordsSchema, (ctx, input) =>
  searchRecords(ctx, input),
);
