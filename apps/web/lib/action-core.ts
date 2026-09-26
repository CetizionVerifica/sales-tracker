import {
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  type Ctx,
} from '@sales-tracker/core';
import { z } from 'zod';

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export const ACTION_ERRORS = {
  unauthenticated: 'Your session has ended. Please sign in again.',
  forbidden: 'You do not have permission to do that.',
  invalid: 'Please check the highlighted fields.',
  notFound: 'That record no longer exists.',
  unexpected: 'Something went wrong. Please try again.',
} as const;

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof UnauthenticatedError)
    return { ok: false, error: ACTION_ERRORS.unauthenticated };
  if (error instanceof ForbiddenError) return { ok: false, error: ACTION_ERRORS.forbidden };
  if (error instanceof NotFoundError) return { ok: false, error: ACTION_ERRORS.notFound };
  if (error instanceof DomainError) return { ok: false, error: error.message };
  if (error instanceof z.ZodError) {
    const { fieldErrors } = z.flattenError(error);
    return {
      ok: false,
      error: ACTION_ERRORS.invalid,
      fieldErrors: fieldErrors as Record<string, string[]>,
    };
  }
  console.error('server action failed', error);
  return { ok: false, error: ACTION_ERRORS.unexpected };
}

/**
 * Builds the server-action wrapper (CLAUDE.md: actions return a result, never throw to the
 * client). `getCtx` is injected so the wrapper is testable without Next.js request APIs.
 */
export function createAction(getCtx: () => Promise<Ctx>) {
  return function action<S extends z.ZodType, T>(
    schema: S,
    handler: (ctx: Ctx, input: z.output<S>) => Promise<T>,
  ) {
    return async (raw: z.input<S>): Promise<ActionResult<T>> => {
      try {
        const ctx = await getCtx();
        const input = schema.parse(raw);
        return { ok: true, data: await handler(ctx, input) };
      } catch (error) {
        return toResult(error);
      }
    };
  };
}
