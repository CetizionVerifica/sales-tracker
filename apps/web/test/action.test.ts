import {
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from '@sales-tracker/core';
import type { Ctx } from '@sales-tracker/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ACTION_ERRORS, createAction } from '../lib/action-core.ts';

const ctx: Ctx = { user: { id: 'u1', role: 'SALES', active: true }, source: 'web' };
const schema = z.object({ name: z.string().min(1) });

function build(getCtx: () => Promise<Ctx>, handler: (c: Ctx, input: { name: string }) => unknown) {
  return createAction(getCtx)(schema, async (c, input) => handler(c, input));
}

describe('AC12: server-action wrapper', () => {
  it('returns { ok: true, data } and passes ctx + parsed input', async () => {
    const handler = vi.fn(async (c: Ctx, input: { name: string }) => `${c.user.id}:${input.name}`);
    const run = build(async () => ctx, handler);
    await expect(run({ name: 'Acme' })).resolves.toEqual({ ok: true, data: 'u1:Acme' });
  });

  it('returns an error (not a throw) when unauthenticated, without running the handler', async () => {
    const handler = vi.fn();
    const run = build(async () => {
      throw new UnauthenticatedError();
    }, handler);
    await expect(run({ name: 'Acme' })).resolves.toEqual({
      ok: false,
      error: ACTION_ERRORS.unauthenticated,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('maps ForbiddenError', async () => {
    const run = build(
      async () => ctx,
      () => {
        throw new ForbiddenError('list', 'user');
      },
    );
    await expect(run({ name: 'Acme' })).resolves.toEqual({
      ok: false,
      error: ACTION_ERRORS.forbidden,
    });
  });

  it('maps invalid input to field errors without calling the handler', async () => {
    const handler = vi.fn();
    const run = build(async () => ctx, handler);
    const result = await run({ name: '' });
    expect(result).toMatchObject({ ok: false, error: ACTION_ERRORS.invalid });
    expect(result.ok === false && result.fieldErrors?.name?.length).toBeTruthy();
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes DomainError messages through and maps NotFoundError', async () => {
    const domain = build(
      async () => ctx,
      () => {
        throw new DomainError('You cannot deactivate yourself');
      },
    );
    await expect(domain({ name: 'x' })).resolves.toEqual({
      ok: false,
      error: 'You cannot deactivate yourself',
    });
    const missing = build(
      async () => ctx,
      () => {
        throw new NotFoundError('user');
      },
    );
    await expect(missing({ name: 'x' })).resolves.toEqual({
      ok: false,
      error: ACTION_ERRORS.notFound,
    });
  });

  it('hides unexpected errors behind a generic message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = build(
      async () => ctx,
      () => {
        throw new Error('connection string with secrets');
      },
    );
    await expect(run({ name: 'x' })).resolves.toEqual({
      ok: false,
      error: ACTION_ERRORS.unexpected,
    });
    spy.mockRestore();
  });

  it('maps a DomainError with a field to fieldErrors (e.g. duplicate name)', async () => {
    const run = build(
      async () => ctx,
      () => {
        throw new DomainError('A sector with this name already exists', { field: 'name' });
      },
    );
    await expect(run({ name: 'x' })).resolves.toEqual({
      ok: false,
      error: 'A sector with this name already exists',
      fieldErrors: { name: ['A sector with this name already exists'] },
    });
  });
});
