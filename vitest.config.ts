import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['{apps,packages}/*/**/*.test.ts', 'tooling/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/web/e2e/**'],
    // Integration tests share one Postgres/Redis; keep files sequential.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
