Read CLAUDE.md and docs/modules/$ARGUMENTS.md.

Plan the implementation of this module: Prisma schema changes, core services,
Zod schemas, status-machine changes, server actions/routes, UI, and tests.
Wait for my approval of the plan.

Then write Vitest tests for every acceptance criterion first, and implement
until they pass. Enforce RBAC via can() and confirm audit rows are written.
Finish by running `pnpm typecheck && pnpm lint && pnpm test` and summarising
changes, decisions made, and open questions.
