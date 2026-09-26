import { describe, expect, it, vi } from 'vitest';
import { auditOperation, pinnedWhere } from '../../audit/extension.ts';
import { registerModelMeta } from '../../audit/model-meta.ts';
import { runInStore } from '../../audit/store.ts';
import { actor } from '../helpers.ts';

// M2 review fix B: bulk writes run only on the rows that were read and audited, so a row
// committed concurrently that matches the filter can never be written without an audit row.
registerModelMeta({
  _runtimeDataModel: {
    models: {
      User: {
        fields: [
          { name: 'id', kind: 'scalar' },
          { name: 'name', kind: 'scalar' },
        ],
      },
    },
  },
});

function fakeTx(rows: { id: string; name: string }[]) {
  return {
    user: { findMany: vi.fn(async () => rows) },
    auditLog: { createMany: vi.fn(async () => ({ count: rows.length })) },
  };
}

const store = (tx: unknown) => ({
  ctx: { user: actor('ADMIN'), source: 'web' as const },
  requestId: 'req-1',
  tx,
});

describe('bulk writes are pinned to the audited rows', () => {
  it.each(['updateMany', 'updateManyAndReturn', 'deleteMany'])('%s', async (operation) => {
    const tx = fakeTx([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]);
    const query = vi.fn(async () => ({ count: 2 }));
    const where = { name: { startsWith: 'x' } };

    await runInStore(store(tx), () =>
      auditOperation({ model: 'User', operation, args: { where, data: { name: 'Z' } }, query }),
    );

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [where, { id: { in: ['a', 'b'] } }] } }),
    );
    const audited = (tx.auditLog.createMany.mock.calls[0] as unknown as [{ data: unknown[] }])[0];
    expect(audited.data).toHaveLength(2);
  });

  it('pins an unfiltered bulk write to the ids read', () => {
    expect(pinnedWhere(undefined, ['a'])).toEqual({ id: { in: ['a'] } });
  });
});
