import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from '../auth/auth.ts';
import { disconnectAll, getDb } from '../clients.ts';

// Step-1 spike from the M1 plan: the admin plugin treats `role` as a string;
// confirm it round-trips through the Prisma `Role` enum column.
describe('Better Auth role ⇄ Prisma Role enum', () => {
  beforeAll(() => resetDb(getDb()));
  afterAll(disconnectAll);

  it('stores and reads back each role through the admin plugin', async () => {
    for (const role of ['ADMIN', 'SALES', 'PROJECT_MANAGER'] as const) {
      const { user } = await getAuth().api.createUser({
        body: {
          email: `${role.toLowerCase()}@example.test`,
          password: 'correct-horse-battery',
          name: role,
          role,
        },
      });
      const row = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.role).toBe(role);
      expect(row.active).toBe(true);
      expect(row.isSystem).toBe(false);
    }
  });

  it('defaults to SALES when no role is given', async () => {
    const { user } = await getAuth().api.createUser({
      body: { email: 'default@example.test', password: 'correct-horse-battery', name: 'Default' },
    });
    const row = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.role).toBe('SALES');
  });
});
