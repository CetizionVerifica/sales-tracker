import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  assertNoNestedWrites,
  changedFields,
  classifyAction,
  toAuditJson,
} from '../../audit/snapshot.ts';

const at = new Date('2026-09-26T10:00:00.000Z');

describe('toAuditJson', () => {
  it('serialises dates as ISO strings and redacts credentials', () => {
    expect(
      toAuditJson({ id: 'a1', password: 'hash', accessToken: 'tok', token: 't', createdAt: at }),
    ).toEqual({
      id: 'a1',
      password: REDACTED,
      accessToken: REDACTED,
      token: REDACTED,
      createdAt: '2026-09-26T10:00:00.000Z',
    });
  });

  it('keeps null credentials as null (nothing to hide)', () => {
    expect(toAuditJson({ id: 'a1', password: null })).toEqual({ id: 'a1', password: null });
  });

  it('returns null for a missing row', () => {
    expect(toAuditJson(null)).toBeNull();
  });
});

describe('changedFields', () => {
  it('lists fields whose values differ, ignoring updatedAt', () => {
    expect(
      changedFields(
        { id: 'u1', name: 'A', active: true, updatedAt: '2026-01-01' },
        { id: 'u1', name: 'B', active: true, updatedAt: '2026-02-02' },
      ),
    ).toEqual(['name']);
  });

  it('reports a changed password even though both sides are redacted', () => {
    expect(changedFields({ password: 'old-hash' }, { password: 'new-hash' })).toEqual(['password']);
  });

  it('compares dates and arrays by value', () => {
    expect(
      changedFields(
        { banExpires: new Date(at), tags: ['a'] },
        { banExpires: new Date(at), tags: ['a'] },
      ),
    ).toEqual([]);
  });

  it('is empty for creates and hard deletes', () => {
    expect(changedFields(null, { id: 'u1' })).toEqual([]);
    expect(changedFields({ id: 'u1' }, null)).toEqual([]);
  });
});

// AC8 (unit part): the integration part arrives in M3 with the first soft-deletable model.
describe('classifyAction', () => {
  it.each([
    ['create', null, { id: '1' }, 'CREATE'],
    ['delete', { id: '1' }, null, 'DELETE'],
    ['update', { deletedAt: null }, { deletedAt: at }, 'SOFT_DELETE'],
    ['update', { deletedAt: at }, { deletedAt: null }, 'RESTORE'],
    ['update', { deletedAt: at }, { deletedAt: new Date(at.getTime() + 1) }, 'UPDATE'],
    ['update', { name: 'a' }, { name: 'b' }, 'UPDATE'],
  ] as const)('%s %o → %o is %s', (operation, before, after, expected) => {
    expect(classifyAction(operation, before, after)).toBe(expected);
  });
});

describe('assertNoNestedWrites (AC4 rules)', () => {
  const relations = ['accounts', 'sessions'];

  it.each([
    { accounts: { connect: { id: 'a1' } } },
    { accounts: { disconnect: [{ id: 'a1' }] } },
    { accounts: { set: [] } },
    { name: 'plain scalar update' },
  ])('allows %o', (data) => {
    expect(() => assertNoNestedWrites('User', relations, data)).not.toThrow();
  });

  it.each([
    'create',
    'createMany',
    'update',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
    'connectOrCreate',
  ])('rejects nested %s', (op) => {
    expect(() => assertNoNestedWrites('User', relations, { accounts: { [op]: {} } })).toThrow(
      /nested write/i,
    );
  });

  it('checks every row of a createMany data array', () => {
    expect(() =>
      assertNoNestedWrites('User', relations, [{ name: 'ok' }, { sessions: { create: {} } }]),
    ).toThrow(/nested write/i);
  });
});
