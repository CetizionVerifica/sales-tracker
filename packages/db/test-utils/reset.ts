import type { DbClient } from '../src/index.ts';

/** Any client with raw SQL (the base client, or core's audited client). */
type RawSqlClient = Pick<DbClient, '$queryRaw' | '$executeRawUnsafe'>;

/**
 * Test-only: empties every application table (keeps migration history).
 * Raw SQL is acceptable here; CLAUDE.md rule 3 governs application writes, not test setup.
 */
export async function resetDb(db: RawSqlClient): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}
