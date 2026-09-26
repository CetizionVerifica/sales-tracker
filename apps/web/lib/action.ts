import { createAction } from './action-core.ts';
import { getCtx } from './auth.ts';

export type { ActionResult } from './action-core.ts';

/** Wraps a server action: builds ctx, validates input with the shared Zod schema. */
export const action = createAction(getCtx);
