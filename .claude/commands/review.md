Review the changes on the current branch (git diff against main) against CLAUDE.md.
Check and report pass/fail with file references for each:

1. All DB access goes through packages/core services (no Prisma in apps/*).
2. Every service method calls can() with the acting user.
3. Every mutation is audited with the correct ctx.source.
4. Money uses integer minor units + currency code.
5. Status changes go through status-machine functions.
6. Zod schemas are shared from packages/core/schemas.
7. AI-extracted values require user confirmation before saving.
8. Tests cover happy path, RBAC denial, audit row, and status transitions.
9. No new dependencies without justification.
10. UI follows docs/UI-GUIDE.md: run its section 10 checklist on every changed screen.
11. `pnpm typecheck && pnpm lint && pnpm test` passes.

List concrete fixes for anything that fails. Do not make changes until I confirm.
