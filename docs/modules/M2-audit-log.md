# M2 — Audit log

Depends on: M0, M1.

## Goal

Every write to business data leaves an append-only audit row: who did it, what changed (before and after), and where it came from (`web`, `mcp`, `import`, `system`). The rows are written by a Prisma client extension in `packages/core`, so no service can forget to write one (CLAUDE.md rule 3). The audit row commits or rolls back together with the change it records. M2 also carries over the M1 items: audit assertions in the `user.service` tests, the audit-log list filter, and the system-actor helper for jobs and imports.

The audit-log **viewer UI** is M3 (PLAN.md). M2 ships the model, the extension, and a read service.

## In scope

### Database (`packages/db`)

- `enum AuditAction { CREATE UPDATE DELETE SOFT_DELETE RESTORE }`.
- `enum AuditSource { web mcp import system }`. The values are lowercase to match `ctx.source` (CLAUDE.md).
- The `AuditLog` model (append-only):
  - `id`: a UUID.
  - `actorId`: a required FK to `User`. Every row has a real actor, the system user included.
  - `action`, `source`.
  - `entityType`: the Prisma model name, e.g. `User`.
  - `entityId`.
  - `before Json?`: null for creates.
  - `after Json?`: null for hard deletes.
  - `changedFields String[]`: for updates, the fields whose values differ.
  - `requestId`: one UUID per service call, so the rows from one action can be grouped.
  - `createdAt`: UTC.
  - Indexes on `(entityType, entityId, createdAt)`, `(actorId, createdAt)` and `(createdAt)`.
- **Immutability is enforced in the database.** The migration adds a trigger that raises an error on any `UPDATE` or `DELETE` of `audit_log`. Test `TRUNCATE` still works, because row triggers do not fire on `TRUNCATE`.
- Migration: `m2_audit_log`.

### Acting context in async storage (`packages/core/context.ts`)

- `runWithCtx(ctx, fn)` stores `{ ctx, requestId, tx? }` in an `AsyncLocalStorage` for the duration of `fn`.
- `withTx(ctx, fn)` opens one **interactive** Prisma transaction inside `runWithCtx`, and exposes its transaction client both to `fn` and to the extension. Every service mutation uses it.
- Batch transactions (`$transaction([...])`) are not used for writes, because the extension cannot join them. `deactivateUser` moves from a batch to `withTx`.
- `systemCtx()` returns `{ user: <the system user>, source: 'system' }`.
  - The system user is looked up on each call (one indexed read), so it is never stale after a database reset.
  - It throws a clear error if the seed has not run.
- `importCtx(ctx)` returns a copy of `ctx` with `source: 'import'`, for M13's bulk import acting as a real user.

### Audit extension (`packages/core/audit/`)

- It is applied inside core's Prisma client (`getDb()`), so every core write goes through it. Apps still cannot import Prisma (lint rule from M0).
- **What it intercepts:** `create`, `createMany` (as `createManyAndReturn`), `update`, `updateMany`, `upsert`, `delete` and `deleteMany` on every audited model.
- **How it works:**
  - It reads the `before` rows first, inside the same transaction as the write.
  - It runs the write, then inserts **one audit row per affected record** in that same transaction.
  - **Audited writes must run inside `withTx`.** A write with a context but no transaction throws `AuditContextError`. (The spec first said the extension would open its own transaction; the planning spike showed that starting a transaction from inside the hook times out in Prisma 7, so the stricter rule applies.)
  - `getDb()` returns the active transaction client inside `withTx`, so every core write, the seed's included, joins the transaction its audit rows use.
  - Better Auth's Prisma adapter gets `authDb`, a proxy that resolves to `getDb()` on every access. Its writes (for example `createUser`'s `User` and `Account` rows) join our transaction; the spike confirmed a rollback removes them.
  - Prisma query promises are lazy. The context store calls `.then()` inside its async-storage scope, so `withTx(ctx, (tx) => tx.user.create(…))` works without an explicit `await`.
- **Action mapping:**
  - Create → `CREATE`; hard delete → `DELETE`; any other update → `UPDATE`.
  - An update that sets `deletedAt` from null to a value → `SOFT_DELETE`; from a value back to null → `RESTORE`. Soft-delete query filtering itself is M3, where the first soft-deletable model appears.
- **Fails closed:**
  - A write to an audited model with no acting context throws `AuditContextError`, and nothing is written.
  - This also covers Better Auth: its writes to audited models must happen inside a service call (as they do for M1's `createUser` and seed paths).
- **Nested writes** on audited relations (for example `user.update({ data: { accounts: { create: ... } } })`) are rejected with a clear error, because the per-model hook cannot see them. Services write each model separately inside `withTx`. Setting a foreign key (`connect`, or a plain id) is allowed: it is recorded in the parent row's `before`/`after`.
- **Redaction:** `password`, `accessToken`, `refreshToken`, `idToken` and `token` are stored as `"[redacted]"`. A change to them still appears in `changedFields`, so "password changed" stays auditable.
- **Audited models:** every model except those on an explicit exclusion list:
  - `AuditLog` itself.
  - `Session` and `Verification`: high-volume auth plumbing with no business meaning (see Decision 3).
  - Any new model is audited by default. Adding it to the exclusion list needs a written reason in the code.
- **Raw write SQL is banned in `packages/core`:**
  - ESLint `no-restricted-properties` blocks `$executeRaw` and `$executeRawUnsafe` in `packages/**`, except `packages/db/test-utils` and package test folders.
  - `$queryRaw` stays allowed for reads (the health check's `SELECT 1`).

### Services

- `services/audit-log.service.ts`:
  - `listAuditLog(ctx, { entityType?, entityId?, actorId?, from?, to?, page, pageSize })` returns rows newest first. `assertCan(ctx, 'list', 'auditLog')` runs first, and the rows are filtered by `scopeAuditLog`.
  - `getAuditEntry(ctx, id)` checks `assertCan(ctx, 'read', { type: 'auditLog', actorId })`.
- `rbac/scope.ts` gains `scopeAuditLog(user)`: admins see every row; everyone else sees only rows where `actorId === user.id`.
- `user.service.ts`:
  - `deactivateUser` switches to `withTx`, so the `User` update is audited. The session deletions are excluded by Decision 3.
  - The read services are unchanged.
- **The seed runs under `systemCtx()`.**
  - The system user is bootstrapped first. Its own `CREATE` row names itself as the actor, written in the same transaction as the user.
  - Every other seeded row (admin, dev users, their accounts) is then audited with `source: 'system'`.
- Zod schema for `listAuditLog`'s input: `packages/core/schemas/audit-log.ts`.

## Out of scope

- The audit-log viewer UI: M3.
- Per-entity history on the client timeline: M5.
- Soft-delete query filtering (hiding `deletedAt` rows by default): M3, with the first soft-deletable models.
- Auditing sign-in and sign-out events, and failed logins: M14 (Decision 7).
- Retention and archiving jobs: none; rows are kept indefinitely (Decision 5).

## Acceptance criteria

**Extension** (integration, real test database):

1. **AC1:** every write operation (`create`, `createMany`, `update`, `updateMany`, `upsert` on both its create and update paths, `delete`, `deleteMany`) on an audited model writes exactly one audit row per affected record. Each row has the correct `action`, `entityType`, `entityId`, `before`, `after`, `changedFields`, `actorId`, `source` and `requestId`. It also covers `createManyAndReturn`, and an `update` whose `select` omits `id` (the id is added for the re-read and stripped from the result). `limit` on bulk writes is rejected. The test runs against `User` and `Account`: no test-only model is added to the production schema.
2. **AC2 (atomicity):** if the transaction around a write rolls back, no audit row remains. If the audit insert fails, the write is rolled back too.
3. **AC3 (fail closed):** a write to an audited model with no acting context throws `AuditContextError`, and the database is unchanged.
4. **AC4:** a nested write to an audited relation is rejected, and nothing is written.
5. **AC5 (redaction):** after a password is set or changed on an `Account`, no audit row contains the password hash. `changedFields` includes `password`.
6. **AC6:** writes to `Session` and `Verification` produce no audit rows. Sign-in and sign-out still work.
7. **AC7 (append-only):** updating or deleting an `AuditLog` row fails, both through Prisma and through raw SQL (the database trigger).
8. **AC8:** setting `deletedAt` from null is classified as `SOFT_DELETE`, and clearing it as `RESTORE`. This is unit-tested through `classifyAction`, because no model has `deletedAt` yet. **The integration test moves to M3**, with the first soft-deletable model.

**Context and services:**

9. **AC9:** `systemCtx()` returns the system user with `source: 'system'`, and throws a clear error when the seed has not run. `withTx` gives every audit row in one call the same `requestId`, and two separate calls get different ones.
10. **AC10:** `listAuditLog`:
    - Admins see every row.
    - `SALES` and `PROJECT_MANAGER` see only their own.
    - Filters (entity, actor, date range) and pagination work, newest first.
    - `getAuditEntry` for another user's row is forbidden to non-admins.
11. **AC11 (M1 carry-over):** every mutating `user.service` method's tests assert its audit row. For `deactivateUser`, that is a `User` `UPDATE` with `changedFields` `['active']`, the acting admin, and `source: 'web'`.
12. **AC12:** after `seed()`, every seeded `User` and `Account` row has a `CREATE` audit row with `source: 'system'`. The system user's own row names itself as the actor.

**PLAN.md "done when" and quality:**

13. **AC13:** every mutation in the test suite writes an audit row. This is enforced by AC3 (unaudited writes fail) plus a test that lists every Prisma model and checks it is either audited or on the documented exclusion list.
14. **AC14:** ESLint rejects `$executeRaw` and `$executeRawUnsafe` in `packages/core` (fixture test, like M0's import-boundary test).
15. **AC15:** `pnpm typecheck && pnpm lint && pnpm test` pass, and `m2_audit_log` applies to an empty database.

## Decisions

1. **Async storage over passing `tx` by hand.** `AsyncLocalStorage` carries `ctx`, `requestId` and the active transaction to the extension. The alternatives were threading the transaction client through every service (error-prone), or extension-only transactions (which cannot be atomic with the service's other writes, and can deadlock when the service's own transaction holds the row lock).
2. **Fail closed.** A write to an audited model without an acting context is a bug, so the extension throws rather than guessing an actor.
3. **`Session` and `Verification` are not audited.** They change on every sign-in and session refresh, and carry no business data. `Account` _is_ audited, with credentials redacted, so password resets (M3) leave a trail.
4. **One audit row per record, including bulk operations.** This keeps entity history simple (M5). Bulk import (M13) will produce many rows; that is acceptable at this scale (a single company).
5. **Retention:** audit rows are kept indefinitely and never archived by the app. Indian record-keeping for invoices usually runs for years, and the data volume is small.
6. **Before/after hold full rows (minus redacted fields), plus `changedFields`.** Full rows make history readable without joins; `changedFields` makes the M3 viewer and M5 timeline cheap to render.
7. **Sign-in events go to M14.** Successful and failed sign-ins and sign-outs are security events, not data changes, so they don't belong in `AuditLog`. M14 (hardening) adds a separate `AuthEvent` table for them.

## Dependencies

None new. `AsyncLocalStorage` is in Node's standard library, and Prisma client extensions are part of `@prisma/client`.

## Risks (resolved by the planning spike)

- **Prisma 7 query extensions and interactive transactions:** ✅ The hook runs everything on the active transaction client, and a rollback removes both the write and its audit row. It sees `createManyAndReturn` as one operation; the extension writes one row per returned record. ❌ It cannot open its own transaction, hence the "writes need `withTx`" rule.
- **Better Auth's own writes:** ✅ Sign-in, session checks and sign-out write only `Session` rows, which are excluded. No `runAsSystem` wrapper is needed.
- **Upsert before-snapshot:** ✅ Both run on the same transaction client (AC1 covers both paths).

## Carried to M3

- The integration test for `SOFT_DELETE` and `RESTORE` audit rows, with the first model that has `deletedAt`.
- The audit-log viewer UI, built on `listAuditLog` and `getAuditEntry`.

## Open questions

None. Sign-in events were settled as Decision 7.
