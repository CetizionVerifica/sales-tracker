# CLAUDE.md — Sales Tracker

Internal sales tracker for **one company** (no multi-tenancy). It tracks each deal through:

**Enquiry → Quotation → Project → Purchase Order → Invoice**

plus follow-ups, a full audit log, a per-user "My Today" task view, dashboards, and an MCP server so Claude can analyse and bulk-load data.

The build plan lives in `docs/PLAN.md`; each module has a spec in `docs/modules/<id>.md`. Always read the module spec before starting work on it.

---

## Tech stack

- **Language:** TypeScript everywhere (`strict: true`). No `any` unless justified in a comment.
- **Monorepo:** pnpm workspaces + Turborepo.
- **Web:** Next.js (App Router), React, Tailwind CSS, shadcn/ui, TanStack Table, React Hook Form, Recharts.
- **Validation:** Zod — one schema per entity, shared by forms, server actions, API routes, MCP tools and AI extraction.
- **DB:** PostgreSQL + Prisma.
- **Auth:** Better Auth (admin plugin). No public sign-up; only admins create users.
- **Files:** Cloudinary. There is no local emulator, so local dev uses a separate dev Cloudinary account.
- **Jobs:** BullMQ + Redis (document extraction, nightly overdue check, reminders).
- **AI extraction:** Anthropic API, PDF/image input, structured JSON validated by Zod.
- **MCP:** `@modelcontextprotocol/sdk`, Streamable HTTP transport.
- **Tests:** Vitest (unit + integration against a test Postgres), Playwright (E2E).

## Repository layout

```
apps/
  web/        Next.js app (UI, server actions, route handlers)
  worker/     BullMQ workers + scheduled jobs
  mcp/        MCP server
packages/
  db/         Prisma schema, migrations, seed, audit extension
  core/       Domain services, Zod schemas, RBAC (can()), status machines
  ui/         Shared UI components (optional)
docs/
  PLAN.md
  modules/    One spec per module (M0–M14)
```

## Commands

```
pnpm dev              # all apps via docker compose deps + turbo
pnpm build
pnpm lint             # eslint
pnpm typecheck        # tsc --noEmit across workspace
pnpm test             # vitest
pnpm test:e2e         # playwright
pnpm db:migrate       # prisma migrate dev
pnpm db:seed          # seed admin, masters, sample pipeline
docker compose up -d  # postgres, redis
```

**Before finishing any task, run `pnpm typecheck && pnpm lint && pnpm test` and fix all failures.**

---

## Architecture rules (non-negotiable)

1. **All reads and writes go through `packages/core` services.** UI, server actions, API routes, workers and MCP tools never call Prisma directly. This keeps RBAC and audit logging in one place.
2. **Every service method takes the acting user (`ctx`) as its first argument** and calls `can(ctx.user, action, resource)` before doing anything.
3. **Every mutation is audited** by the Prisma audit extension in `packages/db`. Pass `ctx.source` (`web` | `mcp` | `import` | `system`). Never bypass it with raw SQL for writes.
4. **Soft delete only** (`deletedAt`). Queries exclude soft-deleted rows by default.
5. **Money:** integer minor units (`amountMinor: BigInt`, since 32-bit `Int` caps paise at ~₹2.1 crore) + ISO currency code (`currency: String`). Never floats. Base currency is INR.
6. **Dates:** store UTC; display in `Asia/Kolkata`. Dates without time (e.g. due date) use `@db.Date`.
7. **Zod schemas live in `packages/core/schemas`** and are the single source of truth for input shapes.
8. **Status changes go through status-machine functions** in `packages/core/status`, never by setting the field directly.
9. **AI-extracted values are never saved without user confirmation.** Extraction writes to `Document.extraction` with `reviewStatus = PENDING`; the user confirms on the review screen.
10. **Secrets** come from env vars validated at startup (`packages/core/env.ts`). Never hard-code keys.

## Roles (RBAC)

| Role              | Access                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ADMIN`           | Everything. Manages users, masters, settings, audit log, MCP tokens.                                                   |
| `SALES`           | CRUD on own enquiries, quotations, follow-ups, POs and invoices in their pipeline. Read on projects for their clients. |
| `PROJECT_MANAGER` | CRUD on assigned projects and their POs/invoices. Read on related enquiries/quotations.                                |

"Own" = `ownerId === user.id`. "Assigned" = `project.managerId === user.id`.

## Domain model (summary)

- **User** — name, email, role, active.
- **CompanySettings** (single row) — company name, `defaultInvoiceDueDays` (30), enabled currencies, base currency.
- **Client**, **Sector**, **Service** — master tables.
- **Enquiry** — client, sector, services, `receivedDate`, `proposalSentDate`, status, owner.
- **Quotation** — enquiry, client (fixed to the enquiry's), sector/service/owner (copied from enquiry, editable), `quotationDate` (defaults to enquiry `proposalSentDate`), amount + currency, status, `nextFollowUpDate`, `lastFollowUpHighlights`, `poReceivedDate`, `lostReason`, document. Edited in place; the audit log is the revision history.
- **Project** — quotation, manager, client, services, revenue, start/end dates, status, `completionPct` (0–100).
- **PurchaseOrder** — project, `poNumber`, `receivedDate`, client, services, amount + currency, `paymentTerms`, `paymentTermsDays`, document, status (derived).
- **Invoice** — PO, `invoiceNumber`, `invoiceDate`, client, service, amount + currency, `dueDate`, status, `paidAt`, document.
- **FollowUp** — client, `entityType` + `entityId`, date, channel, notes, `nextFollowUpDate`, user.
- **Document** — storage key, mime type, `extraction` (JSON), `reviewStatus` (PENDING | CONFIRMED).
- **AuditLog** — actorId, action, entityType, entityId, `before`, `after`, source, createdAt. Append-only.
- **ApiToken** — name, hashed token, scopes, expiresAt, createdBy.

## Status machines

- **Enquiry:** `IN_PROGRESS → CONVERTED | LOST`. `CONVERTED` requires `proposalSentDate` and offers to create a Quotation pre-filled from the enquiry.
- **Quotation:** `SENT ⇄ UNDER_NEGOTIATION → PO_RECEIVED | LOST`. `nextFollowUpDate` required while `SENT` or `UNDER_NEGOTIATION`. `PO_RECEIVED` requires `poReceivedDate` and offers to create a Project. `LOST` requires `lostReason`. Both are terminal.
- **Invoice:** `PENDING → PAID`; `PENDING → OVERDUE` (nightly job when `dueDate < today` and unpaid); `OVERDUE → PAID`.
- **PurchaseOrder:** derived — `OVERDUE` if any invoice is overdue; `PAID` if it has invoices, all are paid, and they total at least the PO amount; else `PENDING` (including a PO with no invoices). Recompute whenever an invoice changes. Never set manually.
- **Invoice due date** = `invoiceDate` + the PO's `paymentTermsDays`, or `CompanySettings.defaultInvoiceDueDays` when the PO has none; overridable per invoice.

## UI

All UI follows docs/UI-GUIDE.md. Read it before building or changing any screen. Use the shared layout and display components it lists, tokens only (no raw colours), and run its checklist before finishing.

## Conventions

- File names: `kebab-case.ts`; React components `PascalCase.tsx`.
- Services: `packages/core/services/<entity>.service.ts` exporting plain async functions.
- Server actions return `{ ok: true, data } | { ok: false, error }`; never throw to the client.
- Forms: React Hook Form + `zodResolver` with the shared schema.
- Tables: TanStack Table with server-side pagination, sorting and filtering.
- UI copy in English; currency formatted with `Intl.NumberFormat('en-IN', …)`.
- Keep components small; co-locate page-specific components under the route folder.

## Testing rules

- Write tests **first** from the module's acceptance criteria.
- Every service method needs tests for: happy path, RBAC denial, and audit row written.
- Every status transition needs a test for allowed and disallowed moves.
- Integration tests use a real test database (reset per test file), not mocks of Prisma.
- Mock the Anthropic API and Cloudinary in tests; never call real external services.
- One Playwright E2E per major user flow (create enquiry → convert → quotation → PO → invoice).

## MCP server rules

- Authenticate with admin-issued `ApiToken` (hashed at rest). Each token acts as a specific user and inherits that user's role.
- Tools call `packages/core` services only, with `ctx.source = 'mcp'`.
- Write tools validate input with the same Zod schemas as the web app.
- `bulk_import` must support `dryRun: true` (default) returning a row-by-row preview and errors; only commit when `dryRun: false`.
- Tool descriptions must state what the tool reads/writes and its limits.

## Workflow for each module

1. Read `CLAUDE.md` and `docs/modules/<id>.md`.
2. Propose a plan (schema changes, services, schemas, UI, tests) and wait for approval.
3. Write failing tests, then implement.
4. Create a Prisma migration with a descriptive name if the schema changed; update the seed.
5. Run `pnpm typecheck && pnpm lint && pnpm test`.
6. Summarise what changed, any decisions made, and anything left open.

## Don'ts

- Don't add new dependencies without saying why in the plan.
- Don't write to the DB outside `packages/core`.
- Don't store money as floats.
- Don't save AI-extracted data without the review step.
- Don't add multi-tenant code — this is a single-company app.
- Don't edit old migrations; create new ones.
