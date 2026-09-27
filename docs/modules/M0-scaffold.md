# M0 — Scaffold

Depends on: nothing. Every later module builds on this.

## Goal

A working, empty monorepo. One command starts all three apps and their infrastructure (`pnpm dev`), and the quality gate (`pnpm typecheck && pnpm lint && pnpm test`) passes locally and in CI. There are **no domain models, no auth and no business logic** yet. Those start in M1.

## In scope

### Workspace

- pnpm workspaces + Turborepo. Root `package.json` pins `packageManager` and `engines.node` (`^22.12 || >=24`; Prisma 7 rejects Node 23).
- Workspaces: `apps/web`, `apps/worker`, `apps/mcp`, `packages/core`, `packages/db`. `packages/ui` is optional per CLAUDE.md and is **not** created in M0.
- Package names: `@sales-tracker/<dir>`.
- Shared `tsconfig.base.json` with `strict: true`, `noUncheckedIndexedAccess: true`. Each workspace extends it.
- Internal packages are consumed as TypeScript source (no build step). Next.js transpiles them; worker and MCP run with `tsx`.
- Root scripts, exactly as listed in CLAUDE.md: `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`, `db:migrate`, `db:seed`, plus `format` / `format:check`.

### Infrastructure (`docker-compose.yml`)

> **Later change:** file storage moved to Cloudinary after M5. MinIO, its bucket-init job and the `S3_*` variables were removed; `env.ts` now validates `CLOUDINARY_*` instead. The MinIO notes below are kept as the original M0 record.

- `postgres` (16), `redis` (7), `minio` (+ a one-shot job that creates the `sales-tracker` bucket). All have health checks.
- Postgres init script creates two databases: `sales_tracker` (dev) and `sales_tracker_test` (tests).
- Only dependencies run in Compose for M0. App images (web, worker, mcp) are M14.
- `pnpm dev` runs `pnpm services:up` (waits for postgres, redis and minio to be healthy, then runs the bucket-init job) and then `turbo dev`. `docker compose up --wait` cannot be used on its own, because it treats the one-shot init job exiting as a failure.

### `packages/db`

- Prisma 7, PostgreSQL, `prisma.config.ts`, and the `@prisma/adapter-pg` driver adapter.
- `schema.prisma` holds a datasource and generator only, with no models. The generated client goes to a gitignored folder and is regenerated on install.
- Exports a singleton `prisma` client factory. The audit extension comes in M2.
- `db:migrate` and `db:seed` scripts are wired up. The seed is a no-op that logs and exits 0; M1 seeds the admin.

### `packages/core`

- `env.ts`: parses `process.env` once with Zod and exports a typed `env`. It throws a readable error that lists every missing or invalid variable. It covers `DATABASE_URL`, `REDIS_URL`, the `S3_*` variables, `NODE_ENV`, `WEB_PORT`, `MCP_PORT`. Later modules add auth and Anthropic keys.
- A `.env.example` at the repo root documents every variable, with values that work against docker compose.
- `system/health.ts`: `checkHealth()` returns `{ status: 'ok' | 'degraded', checks: { db, redis } }`. The DB check is a read-only `SELECT 1` through `packages/db`. It is the only Prisma use in M0.
- Empty `schemas/`, `services/`, `status/` folders (with index files), matching the CLAUDE.md layout.
- `system/` holds infrastructure code that is not a domain service, such as `checkHealth`, which takes no `ctx` and does no RBAC. Everything in `services/` must take `ctx` first and call `can()` (from M1), with no exceptions.

### `apps/web`

- Next.js 16 (App Router), React 19, Tailwind CSS 4. Port 3000.
- shadcn/ui groundwork: `components.json` and a `cn()` util. Components are added per module.
- `/` shows the app name ("Sales Tracker") as a placeholder.
- `GET /api/health` calls `core.checkHealth()` and returns 200 when ok, 503 when degraded.

### `apps/worker`

- A Node process (run with `tsx`) that validates env, opens a BullMQ `Worker` on a `system` queue, and logs `worker ready`.
- It shuts down cleanly on SIGINT/SIGTERM by closing the worker and the Redis connection.
- No real jobs yet. Extraction comes in M7 and the overdue job in M10.

### `apps/mcp`

- An MCP server on `@modelcontextprotocol/sdk` using Streamable HTTP. It listens on port 3001 at `/mcp`, bound to `127.0.0.1` until token auth ships in M13.
- `GET /health` calls `core.checkHealth()`.
- It exposes exactly one tool, `ping`. The tool returns `{ ok: true, version }`, reads nothing and writes nothing, and its description says so.

### Tooling

- ESLint 9 flat config at the root (typescript-eslint, Next plugin for `apps/web`) and Prettier.
- **Architecture guard (lint rule):** `no-restricted-imports` blocks `@prisma/client`, `@prisma/*` and `@sales-tracker/db` everywhere except `packages/db` and `packages/core`. This enforces rule 1 of CLAUDE.md.
- Vitest workspace config: unit tests per package, and integration tests that run against `sales_tracker_test` and Redis.
- Playwright config for `apps/web`, which starts the Next.js server itself.
- `.gitignore`, `.nvmrc`, `.editorconfig`.

### CI (`.github/workflows/ci.yml`)

- Runs on push and PR to `main`. Service containers for Postgres and Redis.
- Steps: install (frozen lockfile), typecheck, lint, format:check, test, build, then Playwright (chromium) against the built app.

### Claude Code hook

- `.claude/settings.json` has a PostToolUse hook on Edit and Write that runs `.claude/hooks/post-edit-check.sh`. For `.ts`, `.tsx`, `.js` and `.mjs` files, the script runs `eslint --fix` on the edited file, then `pnpm typecheck`. Any failure exits 2, so the errors go back to Claude.

## Out of scope

- Any Prisma models or migrations: User and the auth tables come in M1, the audit extension in M2.
- Auth, `can()`, `ctx`: M1.
- S3 client code: M7. M0 only provisions MinIO and validates the `S3_*` env.
- Production Dockerfiles, Sentry, rate limits: M14.

## Acceptance criteria

1. **AC1:** after `pnpm install` and `docker compose up -d --wait` on a clean clone, `pnpm dev` starts web (3000), worker and MCP (3001) with no errors.
2. **AC2:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` all exit 0.
3. **AC3:** `pnpm build` exits 0.
4. **AC4:** `env` parsing succeeds for a valid env and throws an error that names each missing or invalid variable (unit test).
5. **AC5:** with Postgres and Redis up, `checkHealth()` returns `status: 'ok'` (integration test). It returns `degraded` with `db: false` when the DB is unreachable (unit test with an injected failing probe).
6. **AC6:** `GET /api/health` returns 200 `{ status: 'ok' }` (Playwright E2E). The home page renders "Sales Tracker".
7. **AC7:** the MCP server lists exactly one tool, `ping`, and calling it returns `{ ok: true }` (integration test using the SDK client over Streamable HTTP).
8. **AC8:** the worker starts, connects to Redis and shuts down cleanly on SIGTERM (integration test).
9. **AC9:** importing `@sales-tracker/db` from `apps/*` fails lint (a fixture-based test of the ESLint rule).
10. **AC10:** the CI workflow runs typecheck, lint, format check, tests, build and E2E. The workflow file is validated locally with `actionlint` if available; otherwise it is checked on first push.
11. **AC11:** `pnpm db:migrate` and `pnpm db:seed` run successfully against the dev DB (both are no-ops at this stage).

## Dependencies

Beyond the stack in CLAUDE.md:

| Package                                             | Where | Why                                                                                   |
| --------------------------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| `@prisma/adapter-pg`                                | db    | Prisma 7 needs a database adapter to connect to Postgres.                             |
| `ioredis`                                           | core  | The Redis client BullMQ needs; the health check reuses it.                            |
| `clsx`, `tailwind-merge`                            | web   | The `cn()` class-name helper that shadcn/ui components rely on.                       |
| `tsx`                                               | root  | Runs the TypeScript worker, MCP server and seed script without a build step.          |
| `turbo`, `prettier`                                 | root  | Turborepo task runner and formatter, both part of the M0 tooling scope.               |
| `@eslint/js`, `globals`, `@next/eslint-plugin-next` | root  | Needed by the ESLint config: base rules, Node and browser globals, and Next.js rules. |

## Decisions

- **TypeScript 6.0.x, not 7:** typescript-eslint supports TypeScript below 6.1 only.
- **Prisma 7.10 stable:** the npm `latest` tag for the Prisma CLI currently points to an 8.0 release candidate, so the version is pinned explicitly.
- **Source-consumed internal packages:** no per-package build step, which keeps the dev loop fast. This can be revisited in M14 if the production images need compiled output.
- **Postgres 16 / Redis 7** Docker images.
- **ESLint 9, not 10:** `eslint-config-next`'s plugin chain (eslint-plugin-react and others) is safer on 9.
- **Non-default host ports:** Postgres 5440, Redis 6380, MinIO 9010 (API) and 9011 (console). Other local services on this machine already use the defaults. Container ports are unchanged, and `.env.example` matches these values.
- **Node 22 LTS** (`.nvmrc`). Prisma 7's install script rejects Node 23.
- **Env loading:** one `.env` at the repo root. Prisma config, Next config and the Vitest setup each load it when present; CI sets the variables directly. Vitest points `DATABASE_URL` at `TEST_DATABASE_URL`.

## Status

Built. All ACs verified locally: typecheck, lint, format check, 16 Vitest tests, build, 2 Playwright tests, `pnpm dev` health probes, the migrate and seed no-ops, and `actionlint` on the CI workflow. CI itself runs on the first push.
