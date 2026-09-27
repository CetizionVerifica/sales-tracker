# Sales Tracker – Modular Build Plan

Sep 26, 2026 · @Shyam

## Overview

Build a single-company sales tracker in 15 modules (M0–M14), one Claude Code session per module, on a TypeScript stack. It tracks every deal through one pipeline: **Enquiry → Quotation → Project → Purchase Order → Invoice**, with follow-ups, an audit log on every change, a daily task view, and an MCP server so Claude can analyse and bulk-load data.

The app serves one company, so there is no multi-tenancy: no organisation table, no tenant ID on rows. Company-wide settings (name, default invoice due days, currencies) live in a single `CompanySettings` row that admins edit.

The companion `CLAUDE.md` file holds the rules Claude Code must follow in every session; this doc is the plan and the reference for why.

## Tech stack

One language (TypeScript) across web app, worker and MCP server, so validation and business rules are written once in a shared `core` package.

| Layer               | Choice                                                                     | Why                                                                    |
| ------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Repo                | pnpm workspaces + Turborepo                                                | Web, worker and MCP apps share `core` and `db` packages                |
| Web app             | Next.js (App Router) + React                                               | UI, server actions and route handlers in one deployable                |
| UI                  | Tailwind CSS, shadcn/ui, TanStack Table, React Hook Form, Recharts         | Fast CRUD screens, data grids, dashboards                              |
| Validation          | Zod                                                                        | One schema for forms, API, MCP tools and AI extraction output          |
| Database            | PostgreSQL + Prisma                                                        | Relational pipeline data; Prisma client extensions power the audit log |
| Auth                | Better Auth (admin plugin)                                                 | Admin-created users, roles, sessions, no public sign-up                |
| File storage        | S3-compatible: MinIO locally, AWS S3 (ap-south-1) or Cloudflare R2 in prod | PO and invoice PDFs and images                                         |
| Document extraction | Claude API with PDF/image input and structured JSON output                 | Reads PO amount, payment terms, invoice number, date, client           |
| Background jobs     | BullMQ + Redis                                                             | Extraction queue, nightly overdue check, reminders                     |
| MCP server          | `@modelcontextprotocol/sdk`, Streamable HTTP transport                     | Lets Claude query, analyse and bulk-import data                        |
| Email (optional)    | Resend or SMTP                                                             | Follow-up and overdue reminders                                        |
| Testing             | Vitest, Playwright                                                         | Unit/integration and end-to-end feedback loop for Claude Code          |
| Deploy              | Docker Compose (postgres, redis, minio, web, worker, mcp)                  | One command locally; portable to any VPS or cloud                      |

## Roles and permissions

Three roles; admins see everything, everyone else sees what they own or are assigned. All checks go through one `can(user, action, resource)` helper in `core`.

| Area                     | Admin            | Sales               | Project manager          |
| ------------------------ | ---------------- | ------------------- | ------------------------ |
| Users, masters, settings | Full CRUD        | No access           | No access                |
| Enquiries, quotations    | All records      | Own records (CRUD)  | Read, on their projects  |
| Projects                 | All records      | Read, own clients   | Assigned projects (CRUD) |
| POs, invoices            | All records      | Own pipeline (CRUD) | Assigned projects (CRUD) |
| Follow-ups               | All records      | Own                 | Own                      |
| Audit log                | Read all         | Read own changes    | Read own changes         |
| Dashboards               | Company-wide     | Personal            | Assigned projects        |
| MCP tokens               | Issue and revoke | No                  | No                       |

Deletes are soft deletes (`deletedAt`), so the audit trail and reports stay intact.

## Data model

Client, sector and service become master tables instead of free text, so reports group cleanly. Fields marked _inherited_ are copied from the parent record when it is created and stay editable.

| Entity                  | Key fields                                                                                                                                   | Relations                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| User                    | name, email, role (ADMIN / SALES / PROJECT\_MANAGER), active                                                                                 | Owns enquiries; manages projects      |
| CompanySettings (1 row) | company name, default due days (30), currencies, base currency (INR)                                                                         | —                                     |
| Client                  | name, sector, contacts                                                                                                                       | Has enquiries, projects, POs          |
| Sector, Service         | name, active                                                                                                                                 | Masters                               |
| Enquiry                 | client, sector, service(s), received date, proposal sent date, status, owner                                                                 | 1 → many quotations                   |
| Quotation               | client/sector/service/owner (inherited), quotation date, amount + currency, status, next follow-up date, last follow-up highlights, document | Belongs to enquiry; 1 → 1 project     |
| Project                 | PM, client, services, revenue, start/end dates, status, completion %                                                                         | 1 → many POs                          |
| PurchaseOrder           | PO number, received date, client, services, amount (extracted), payment terms (extracted), document, status (derived)                        | Belongs to project; 1 → many invoices |
| Invoice                 | invoice number, date, client (extracted), service, amount, due date, status, paid date, document                                             | Belongs to PO                         |
| FollowUp                | client, linked entity (type + id), date, channel, notes, next follow-up date, user                                                           | Timeline per client                   |
| Document                | storage key, file type, extraction JSON, review status (PENDING / CONFIRMED)                                                                 | Attached to quotation, PO, invoice    |
| AuditLog                | actor, action, entity type + id, before/after JSON, source (web / mcp / import), timestamp                                                   | Append-only                           |
| ApiToken                | name, hashed token, scopes, expiry, created by                                                                                               | For MCP access                        |

Money is stored as integer minor units (paise, cents) plus an ISO currency code.

Status rules:

- **Enquiry:** IN\_PROGRESS → CONVERTED or LOST. CONVERTED requires a proposal sent date and prompts quotation creation.
- **Quotation:** SENT ⇄ UNDER\_NEGOTIATION → PO\_RECEIVED. Next follow-up date is required in SENT and UNDER\_NEGOTIATION. PO\_RECEIVED prompts project creation.
- **Invoice:** PENDING → PAID, or PENDING → OVERDUE (nightly job, once past due date) → PAID.
- **PurchaseOrder:** derived, never set by hand. PAID when all invoices are paid, OVERDUE when any is overdue, otherwise PENDING.

## Modules and build order

Build in this order: each module depends only on those above it. Each gets a spec file at `docs/modules/<id>.md` and one Claude Code session.

| #   | Module                     | Scope                                                                                                                                     | Done when                                                        |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| M0  | Scaffold                   | Monorepo (`apps/web`, `apps/worker`, `apps/mcp`, `packages/core`, `packages/db`), Docker Compose, ESLint/Prettier, Vitest, Playwright, CI | `pnpm dev` starts all services; `pnpm test` passes               |
| M1  | Auth and RBAC              | Better Auth login, sessions, roles, `can()` helper, route and service guards, seed admin                                                  | A sales user cannot read another user's enquiry (test)           |
| M2  | Audit log                  | Prisma extension recording create/update/delete with actor, diff and source                                                               | Every mutation in the test suite writes an audit row             |
| M3  | Admin                      | User CRUD (create, deactivate, reset password, role), masters (clients, sectors, services), CompanySettings, audit-log viewer             | Admin manages users; non-admins get 403                          |
| M4  | Enquiries                  | CRUD, list with filters (status, owner, sector, dates), convert/lose actions                                                              | Converting pre-fills a new quotation                             |
| M5  | Follow-ups and timeline    | Log follow-ups on any entity; per-client timeline of follow-ups, status changes and documents                                             | Timeline shows mixed events in date order                        |
| M6  | Quotations                 | Amount + currency, status machine, required next follow-up date, highlights from latest follow-up                                         | PO\_RECEIVED prompts project creation                            |
| M7  | Documents and extraction   | Upload to Cloudinary, queue job, Claude extracts fields to a Zod schema, review-and-confirm screen                                        | Extracted values never save without user confirmation            |
| M8  | Projects                   | CRUD, PM assignment, completion %, linked POs                                                                                             | PM sees only assigned projects                                   |
| M9  | Purchase orders            | Upload PO, extract amount and payment terms, derived status                                                                               | Status updates when invoices change                              |
| M10 | Invoices                   | Upload, extract number/date/client, client mismatch warning, due date from settings, nightly overdue job                                  | Past-due unpaid invoices become OVERDUE                          |
| M11 | My Today                   | Per-user view: follow-ups due or missed, quotations awaiting reply, invoices due or overdue, stale enquiries                              | Shows correct items for seeded data                              |
| M12 | Dashboards and reports     | Funnel, conversion by sector/service/owner, quoted vs won, receivables ageing, revenue by client, CSV export                              | Numbers match seeded fixtures                                    |
| M13 | MCP server and bulk import | Token auth, read tools, write tools, CSV/Excel import with dry run                                                                        | Claude can query and import via MCP; writes are audited as `mcp` |
| M14 | Hardening and deploy       | Rate limits, upload limits, backups, Sentry, production images, seed script                                                               | Production compose runs from a clean machine                     |

Suggested MCP tools for M13: `search_enquiries`, `get_client_timeline`, `create_enquiry`, `log_follow_up`, `update_status`, `bulk_import` (dry run first), `pipeline_summary`, `overdue_invoices`, `revenue_breakdown`. They call the same `core` services as the web app, so RBAC and auditing apply automatically.

## Claude Code workflow

Put `CLAUDE.md` at the repo root before M0, then run one module per session with tests written first.

1. Create an empty repo, add `CLAUDE.md` and `docs/modules/`, and commit.
2. Before each module, write (or ask Claude to draft) `docs/modules/<id>.md`: scope, fields, rules, acceptance criteria.
3. Start Claude Code, switch to plan mode (Shift+Tab), and paste the module prompt below. Review and adjust the plan before approving.
4. Let Claude write failing tests from the acceptance criteria, then implement until `pnpm typecheck && pnpm test` passes.
5. Run the `/review` command (see CLAUDE.md) to check RBAC, audit logging and schema rules, then commit.
6. Run `/clear` and move to the next module.

Module prompt template:

```
Read CLAUDE.md and docs/modules/M4-enquiries.md.
Plan the implementation: Prisma schema changes, core service,
Zod schemas, server actions/routes, and UI (list, filters, form).
Write Vitest tests for every acceptance criterion first, then implement.
Enforce RBAC via can() and confirm audit rows are written.
Finish by running pnpm typecheck && pnpm test and summarising changes.
```

Useful additions to the repo:

- `.claude/commands/review.md`: a checklist prompt for reviewing a finished module.
- `.claude/commands/module.md`: the prompt template above, taking the module id as an argument.
- `.claude/settings.json` hook: run `pnpm lint --fix` and `pnpm typecheck` after file edits so errors surface immediately.

## Decisions and open questions

Decided:

- Single company: no multi-tenancy; settings in one `CompanySettings` row.
- Quotation date defaults to the enquiry's proposal sent date (the requirement's "date of quotation populated from enquiry").
- PO numbers are entered on the project once the quotation reaches PO\_RECEIVED (the requirement says "sent – PO received").
- Invoices get a PENDING status in addition to PAID and OVERDUE.
- AI-extracted document fields always pass through a human review step.

Still open (settle before the module that needs it):

- [ ] Can a quotation have revisions, or is it edited in place? (M6)
- [x] Can one enquiry cover several services? (M4) Yes: see M4 Decision 2.
- [ ] Are partial invoice payments needed? (M10)
- [ ] Should reports convert USD and other currencies to INR, and at which rate: quote date or current? (M12)
- [ ] Who can mark an invoice PAID: sales, PM, or admin only? (M10)
- [ ] Where will it be hosted: company VPS, AWS Mumbai, or another cloud? (M14)
