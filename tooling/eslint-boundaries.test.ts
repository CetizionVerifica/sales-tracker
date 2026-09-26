import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });

async function restrictedImportErrors(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports');
}

const dbImport =
  "import { createPrismaClient } from '@sales-tracker/db';\nvoid createPrismaClient;\n";
const prismaImport = "import { PrismaClient } from '@prisma/client';\nvoid PrismaClient;\n";

describe('architecture boundary lint rule (CLAUDE.md rule 1)', () => {
  it.each([
    'apps/web/app/page-fixture.ts',
    'apps/worker/src/fixture.ts',
    'apps/mcp/src/fixture.ts',
  ])('rejects direct DB imports in %s', async (filePath) => {
    expect(await restrictedImportErrors(filePath, dbImport)).toHaveLength(1);
    expect(await restrictedImportErrors(filePath, prismaImport)).toHaveLength(1);
  });

  it.each(['packages/core/services/fixture.ts', 'packages/db/src/fixture.ts'])(
    'allows DB imports in %s',
    async (filePath) => {
      expect(await restrictedImportErrors(filePath, dbImport)).toHaveLength(0);
    },
  );
});
