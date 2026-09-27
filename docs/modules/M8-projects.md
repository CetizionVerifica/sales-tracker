# M8 — Projects

Depends on: M0, M1, M2, M3, M4, M5, M6, M7.

## Goal

A project is the work delivered after a client sends a purchase order. When a quotation reaches `PO_RECEIVED`, its sales owner (or an admin) creates the project from it and assigns a project manager. From then on the PM runs the project: they move it through its statuses and keep the completion % and dates current. Purchase orders (M9) and invoices (M10) hang off it.

- CRUD on projects, created from a `PO_RECEIVED` quotation using M6's `getProjectDraft`, with RBAC and audit logging through `packages/core`.
- PM assignment, a project status machine (`NOT_STARTED → IN_PROGRESS ⇄ ON_HOLD → COMPLETED | CANCELLED`), completion % (0–100), and start / planned end / completed dates.
- Revenue stored as integer minor units plus an ISO currency code, defaulting to the quotation amount.
- **Project-manager visibility wired end to end:** PMs see their assigned projects, plus read access to the enquiries, quotations, follow-ups and documents behind them. This resolves every `TODO(M8)` left in `rbac/scope.ts` by M4 and M6.
- Follow-ups on projects (the `PROJECT` follow-up target M5 reserved) and project events on the client timeline.
- A **Purchase orders** section on the project page. The `PurchaseOrder` model arrives in M9, so M8 ships the section with its empty state and the contract M9 fills in (the same pattern as M6 → M8).
- Replaces M6's placeholder `/projects/new` page with the real form.

PLAN.md "done when": PM sees only assigned projects.

## In scope

### Database (`packages/db`)

- **`ProjectStatus`** enum: `NOT_STARTED`, `IN_PROGRESS`, `ON_HOLD`, `COMPLETED`, `CANCELLED` (the UI guide's four badge statuses plus `CANCELLED`, Decision 12).
- **`Project`**:
  - `id`, `quotationId` (FK `Quotation`), `clientId` (FK `Client`, copied from the quotation and fixed; Decision 3), `managerId String?` (FK `User`; Decision 5).
  - `number String @unique`: e.g. `PRJ-2026-0007`, from `nextNumber(tx, 'PRJ', year)` (Decision 8). Assigned on create, never changed or reused.
  - `name String`: short title, 1–200 chars. Defaults in the form to `<client> — <services>`.
  - `revenueMinor BigInt` and `currency String` (M6 Decision 3). Default: the quotation's amount and currency.
  - `status ProjectStatus @default(NOT_STARTED)`, `statusChangedAt DateTime?`.
  - `completionPct Int @default(0)`.
  - `startDate DateTime? @db.Date`: required from `IN_PROGRESS` on.
  - `endDate DateTime? @db.Date`: the **planned** end.
  - `completedDate DateTime? @db.Date`: the actual end, required when `COMPLETED` (Decision 7).
  - `holdReason String?`: required when `ON_HOLD`, 1–500 chars; kept after leaving hold (the audit log has the history).
  - `cancelReason String?`: required when `CANCELLED`, 1–500 chars (Decision 12).
  - `description String?`: scope or delivery notes, ≤ 2000 chars.
  - `createdAt`, `updatedAt`, `deletedAt DateTime?` (soft-deletable).
  - Indexes: `(managerId, status)` (PM list and M11), `(clientId)`, `(status, endDate)` (behind-schedule filter, M12), and a **partial unique index** on `quotationId WHERE "deletedAt" IS NULL` (one live project per quotation; Decision 2). Prisma cannot express the partial index, so it goes in the migration SQL with a `@@index([quotationId])` in the schema.
- **`ProjectService`** (explicit join, as M4 Decision 2 and M6's `QuotationService`):
  - `id`, `projectId` (FK), `serviceId` (FK), `createdAt`.
  - `@@unique([projectId, serviceId])`. Not soft-deletable; removal is a hard `DELETE`, audited with the `before` row.
- Back-relations on `Quotation` (`projects Project[]`), `Client`, `Service` and `User` (`managedProjects`).
- `CHECK` constraints in the migration SQL:
  - `"revenueMinor" >= 0`, `"currency" ~ '^[A-Z]{3}$'`.
  - `"completionPct" BETWEEN 0 AND 100`.
  - `status <> 'COMPLETED' OR ("completionPct" = 100 AND "completedDate" IS NOT NULL)`.
  - `status = 'NOT_STARTED' OR "startDate" IS NOT NULL`.
  - `status <> 'ON_HOLD' OR "holdReason" IS NOT NULL`.
  - `status <> 'CANCELLED' OR "cancelReason" IS NOT NULL`.
  - `"endDate" IS NULL OR "startDate" IS NULL OR "endDate" >= "startDate"`.
  - `"completedDate" IS NULL OR "startDate" IS NULL OR "completedDate" >= "startDate"`.
- Both models are audited automatically; the M2 coverage test must pass.
- Migration: `m8_projects`.

### RBAC (`packages/core/rbac`)

The `project` policy rule already exists (M1 Decisions 1 and 3): Sales `create` / `read` / `list` projects on quotations they own; PMs `read` / `update` / `list` projects assigned to them; only admins delete. **No change to `policy.ts`.** M8 changes what feeds it:

- **`projectResource(row)`** builds `{ type: 'project', managerId, quotationOwnerId }`, where `quotationOwnerId` is the source quotation's **current** `ownerId`, loaded by the service, not stored on the project. Reassigning a quotation moves its project's Sales visibility with it (Decision 4).
- **`scopeProjects(user)`**:
  - `ADMIN`: `{}`.
  - `SALES`: `{ quotation: { ownerId: user.id } }`.
  - `PROJECT_MANAGER`: `{ managerId: user.id }` (**the "done when"**).
- **Resolving the `TODO(M8)`s** (M4 "For M8", M6 RBAC):
  - `scopeQuotations` for PMs: `{ projects: { some: { managerId: user.id, deletedAt: null } } }`.
  - `scopeEnquiries` for PMs: `{ quotations: { some: { projects: { some: { managerId: user.id, deletedAt: null } } } } }`.
  - `quotationResource` and `enquiryResource` now take the managers of the **live** projects under the row (`projectManagerIds`). Their callers load those ids in the same query (a `select` on the relation), so no extra round trip per row. One helper, `projectManagerIdsFor`, builds the select for both.
  - The M4 and M6 tests pinning "PMs see nothing" are updated, not deleted, to pin the new behaviour.
  - PM access to enquiries and quotations stays **read only** (M1 policy). Follow-ups and documents inherit it through the M5/M7 registries with no further change: a PM can read quotation documents and log follow-ups on records they can read, but cannot upload to or confirm a quotation document.
- Creating a project needs `read` on the quotation (checked with `quotationResource`) before `assertCan(ctx, 'create', projectResource(...))` with the quotation's owner.

### Status machine (`packages/core/status/project.ts`)

- Pure functions, no database access:
  - `canTransitionProject(from, to): boolean`.
  - `assertProjectTransition(project, to, input)`: throws `DomainError` with a field when a rule fails.
- Allowed moves:
  - `NOT_STARTED → IN_PROGRESS`, `NOT_STARTED → ON_HOLD`.
  - `IN_PROGRESS → ON_HOLD`, `ON_HOLD → IN_PROGRESS`.
  - `IN_PROGRESS → COMPLETED`, `ON_HOLD → COMPLETED`.
  - `NOT_STARTED → CANCELLED`, `IN_PROGRESS → CANCELLED`, `ON_HOLD → CANCELLED`.
  - Everything else is rejected, including same-state moves, anything back to `NOT_STARTED`, and anything out of `COMPLETED` or `CANCELLED` (both terminal; Decisions 12 and 13).
- Moving to `IN_PROGRESS` requires a `startDate` (stored, or supplied with the action; pre-filled with today in the dialog), not in the future.
- Moving to `ON_HOLD` requires a `holdReason`. From `NOT_STARTED` it also requires a `startDate`, which satisfies the `CHECK` (a project put on hold before work starts records when it was committed to).
- Moving to `COMPLETED` requires a `completedDate`, not in the future and not before `startDate`, and sets `completionPct = 100`.
- Moving to `CANCELLED` requires a non-empty `cancelReason`. `completionPct` and the dates are kept as they were, so M12 can see how far a cancelled project got.
- Who may make a move is checked in the service, not here: `CANCELLED` is admin-only (Decision 12).
- Exported from `packages/core/status/index.ts`.

### Schemas (`packages/core/schemas/project.ts`)

- Reuses M6's `moneySchema`, `formatMoney` and `toAmountString` for revenue, and M4's `calendarDateSchema` / M6's `requiredDay` for dates.
- As in M6, a **form** schema that keeps `revenue` as typed (`createProjectFormSchema`, `updateProjectFormSchema`) and a service schema that converts it to `revenueMinor` (`createProjectSchema`, `updateProjectSchema`).
- `createProjectSchema`: `quotationId`, `name`, `managerId?`, `serviceIds` (1–10 unique), `revenue`, `currency`, `startDate?`, `endDate?`, `description?`. **No `clientId`, `status`, `completionPct`, `completedDate`, `holdReason` or `cancelReason`**: it always starts `NOT_STARTED` at 0%.
- `updateProjectSchema`: `name`, `managerId`, `serviceIds`, `revenue`, `currency`, `startDate`, `endDate`, `completionPct` (integer 0–100), `description`, all optional. **No `status`, `number`, `clientId`, `quotationId`, `completedDate`, `holdReason` or `cancelReason`.** Empty string clears optional fields, `undefined` leaves them unchanged (M3 convention). Which fields a role may change is checked in the service (Decision 6).
- `changeProjectStatusSchema`, discriminated on `to`:
  - `{ id, to: 'IN_PROGRESS', startDate? }`.
  - `{ id, to: 'ON_HOLD', holdReason, startDate? }`.
  - `{ id, to: 'COMPLETED', completedDate }`.
  - `{ id, to: 'CANCELLED', cancelReason }` (1–500 chars).
- `listProjectsSchema`: `listParamsSchema` plus `status[]`, `managerId` (or `'none'` for unassigned), `clientId`, `serviceId`, `quotationId`, `ownerId` (the quotation's owner; admins only), `currency[]`, `startFrom/To`, `endFrom/To`, `behindSchedule` (`NOT_STARTED`, `IN_PROGRESS` or `ON_HOLD`, and `endDate < today` IST), `recordStatus`. `q` searches project number, name, quotation number, client name and cancel reason. Sortable: `createdAt` (default, desc), `number`, `name`, `client`, `manager`, `status`, `completionPct`, `startDate`, `endDate`, `revenue` (mixed currencies sort by minor units, noted in the UI, as M6), `updatedAt`.
- Dates: `startDate` may be in the future only while `NOT_STARTED` (a planned start). `endDate` on or after `startDate`. `completedDate` not in the future.
- Action-input shapes (`withId(...)`, `idOnlySchema`) live in core.
- **`listQuotationsSchema`** gains `hasProject` (boolean) so the "New project" entry points can list `PO_RECEIVED` quotations still waiting for one.

### Services (`packages/core/services/project.service.ts`)

Each function takes `ctx`, validates with the schema, calls `assertCan`, and writes inside `withTx`. Status and delete writes are conditional `updateMany` calls that re-check the status and `deletedAt` that were read (the M4/M5 race fix); a request that loses the race fails with "Someone else changed this project".

- `listProjects(ctx, input)`: `assertCan(ctx, 'list', 'project')`, `scopeProjects` ANDed with filters. Returns `Page<ProjectRow>` with quotation number, client, manager, owner and service names, formatted revenue, and `behindSchedule`.
- `getProject(ctx, id)`: not visible → `NotFoundError` (M4 Decision 7). Includes the quotation (number, amount, `poReceivedDate`), its enquiry id and number (for the pipeline strip), services, manager, and the permissions the page needs (`canUpdate`, `canChangeStatus`, `canReassign`, `canDelete`, `editableFields`).
- `createProject(ctx, input)`:
  - The quotation must be live, readable and `PO_RECEIVED`; otherwise not found (unreadable) or `DomainError` on `quotationId`.
  - The quotation must not already have a live project: `DomainError` "This quotation already has a project (PRJ-…)". The partial unique index backs this for concurrent creates (AC13).
  - `clientId` copied from the quotation. `managerId`, when given, must be an active `PROJECT_MANAGER` user (Decision 5).
  - Every `serviceId` must be live and active; `currency` must be enabled. Both are re-checked only for values that differ from the quotation's (a quotation in a since-retired service can still become a project; the M3 retired-master fix).
  - Assigns `number` with `nextNumber(tx, 'PRJ', year of today in IST)`.
  - Creates the `Project` row (status `NOT_STARTED`, `completionPct = 0`, `statusChangedAt = now`), then one `ProjectService` row per service, as separate writes (M2 rejects nested writes).
  - `getProjectDraft` (M6) now also rejects a quotation that has a live project, and returns `existingProjectId` in that error so the page can redirect.
- `updateProject(ctx, id, input)`:
  - `update` permission (admins, and the assigned PM). Sales cannot edit a project after creating it (M1 policy; Decision 14).
  - Field rules (Decision 6):
    - The assigned PM may change `name`, `startDate`, `endDate`, `completionPct` and `description`.
    - Admins may also change `managerId`, `serviceIds`, `revenue` and `currency`.
    - A PM sending an admin-only field gets a `DomainError` on that field, not a silent ignore.
  - `COMPLETED` and `CANCELLED` projects: only `description` may change; `completionPct` is fixed (100 when completed, as it stood when cancelled).
  - `startDate` cannot be cleared once the project has left `NOT_STARTED` (checked on merged values).
  - Masters and currency re-checked only when they **change**. Services diffed as in M4.
  - Changing `managerId` to another PM, or clearing it, is an ordinary audited `UPDATE`. The old PM loses access immediately (their next request is scoped out).
- `changeProjectStatus(ctx, input)`: `update` permission, status machine, then one guarded update setting `status`, `statusChangedAt` and the supplied `startDate`, `holdReason`, `completedDate` or `cancelReason` (plus `completionPct = 100` for `COMPLETED`). A move to `CANCELLED` by anyone but an admin is a `ForbiddenError` (Decision 12).
- `softDeleteProject` / `restoreProject`: `delete` permission (admins only). Any status can be deleted in M8; M9 adds "not while it has live purchase orders" (see For M9). Deleting a project frees its quotation for a new project. Restoring requires the quotation to be live and to have no other live project.
- `listProjectsForQuotation(ctx, quotationId)` and `listProjectsForClient(ctx, clientId)`: for the quotation and client pages; apply `scopeProjects`.
- `listProjectManagerOptions(ctx)`: active `PROJECT_MANAGER` users for the manager select (the M4 `listEnquiryOwnerOptions` pattern). Available to anyone who can create or reassign a project.

**Follow-up target** (`follow-up-targets.ts`): add a `PROJECT` entry: `auditModel: 'Project'`, `load` (label = project number and name; resource = `projectResource`), `visibleIds` (through `scopeProjects`), `labels`, `pickable`. No `afterChange` or `requiresNextFollowUp`: projects keep no follow-up fields. `scopeFollowUps` gains the `PROJECT` branch and PMs see follow-ups on their projects and on the quotations and enquiries behind them.

**Timeline** (`timeline.service.ts`): project `CREATED`, `STATUS_CHANGE` (`NOT_STARTED → IN_PROGRESS` etc., with `holdReason`, `completedDate` and `cancelReason` whitelisted in the summary), `DELETED` and `RESTORED` events through the registry. Completion % and revenue changes are not timeline events; they are on the record's Audit tab.

**Quotation side** (`quotation.service.ts`):

- `getQuotation` returns `project: { id, number } | null` (the live project, if the user can read it; otherwise just `hasProject: true`).
- `softDeleteQuotation` already blocks `PO_RECEIVED`, so a project can never lose its quotation.

### Seed

- Development only: a project for most seeded `PO_RECEIVED` quotations, covering all five statuses (one on hold with a reason, one completed with a completed date, one cancelled with a reason, one behind schedule), one left unassigned, the rest managed by the seeded dev PM. At least one `PO_RECEIVED` quotation is left **without** a project, so the create flow can be tried by hand.
- One or two follow-ups logged on projects by the PM.
- Written through the services in the same all-or-nothing seed transaction, as the quotation's owning Sales user (create) and the PM (status changes), `source: 'system'`. Added when no projects exist, even if quotations do (the M5/M6 pattern). M6's seed may need one more `PO_RECEIVED` quotation to cover this; add it there.

### Web (`apps/web`)

Follows `docs/UI-GUIDE.md` (templates 4.1–4.3, `--stage-project`, the project status badges) and its checklist.

- **Nav:** **Projects** in the pipeline group with `stage: 'project'`, shown when `can(user, 'list', 'project')`. For PMs it is the first pipeline item. **+ New → Project** (Sales and admins only) opens `/quotations?status=PO_RECEIVED&hasProject=false`, since a project always starts from a quotation.
- **`/projects`** (list, template 4.1):
  - Summary strip: Not started, In progress, On hold, Behind schedule (clickable filter chips).
  - Columns: number (links to detail), name, client, quotation number, manager (avatar; "Unassigned" in muted text), status badge, completion (a thin progress bar with the number), planned end (red when behind schedule), revenue (`<Money>`), updated.
  - Filters: status (multi), manager (admins and Sales; includes "Unassigned"), owner (admins only), client, service, start and planned-end ranges, "Behind schedule" toggle, search, "Deleted" view with Restore (admins).
  - PMs see only their projects and no manager filter (**the "done when"**).
  - No "New project" button for PMs. For Sales and admins, **New project** links to the quotation list as above.
- **`/projects/new?quotationId=…`** (replaces the M6 placeholder; a full page at max 880px, as the UI guide's form template says for projects):
  - React Hook Form + `zodResolver` with the core form schema; server action via M1's `action()`.
  - Pre-filled from `getProjectDraft`: client (read-only, "From QUO-…"), services, revenue and currency ("From QUO-…"), name.
  - Manager select from `listProjectManagerOptions` (optional, "Assign later" allowed), planned start and end dates, description.
  - If the quotation already has a project, redirects to it with a toast.
  - Footer: `[Cancel]` `[Create project]`.
- **`/projects/[id]/edit`**: same page, fields limited to what `editableFields` allows; admin-only fields are hidden for PMs, not disabled.
- **`/projects/[id]`** (detail, template 4.2):
  - Header: number and name, status badge, `[Log follow-up]` `[Edit]` `[⋯]`.
  - Pipeline strip: Enquiry and Quotation filled and linked, Project current.
  - Tabs: Overview | Timeline | Documents | Audit. Documents shows "Project documents are not supported" as an empty state for now (M7 Decision 2 attaches documents to quotations, POs and invoices only); the PO and invoice documents appear there from M9/M10.
  - Overview: scope and dates, a completion bar with **Update progress** (a small popover with a 0–100 input and quick picks 25/50/75), and a **Purchase orders** section with the empty state "Purchase orders arrive in a later release" (M9 replaces it).
  - Side panel: client, manager, quotation owner, revenue (and the quotation amount beneath when they differ), start, planned end (red with "N days behind" when behind schedule), completed date, PO received date from the quotation.
  - Status actions by status and permission, each behind a dialog:
    - `NOT_STARTED`: **Start project** (start date, pre-filled today), **Put on hold** (reason, start date).
    - `IN_PROGRESS`: **Put on hold** (reason), **Mark completed** (completed date, pre-filled today; the dialog says completion will be set to 100%).
    - `ON_HOLD`: **Resume** (hold reason shown), **Mark completed**.
    - `NOT_STARTED`, `IN_PROGRESS` and `ON_HOLD` also get **Cancel project** (admins only; reason required; destructive style behind a confirmation that names the project).
    - `COMPLETED`: none. `CANCELLED`: none; the cancel reason is shown under the status badge.
  - `⋯`: **Reassign manager** (admins), **Delete** (admins; confirmation names the project).
- **`/quotations/[id]`**: for `PO_RECEIVED`, the **Create project** prompt becomes a **Project** link (number and status badge) once a project exists. The pipeline strip links the Project stage. The M6 E2E is updated to follow the real form.
- **`/enquiries/[id]`**: the pipeline strip links to the project when exactly one exists under the enquiry; otherwise the quotations section shows each quotation's project.
- **`/clients/[id]`**: a **Projects** section (the M6 implementation note: sidebar sections, not tabs), latest ten, linking to the filtered list. Timeline record filter includes projects (`?record=PROJECT:<id>`).
- `apps/web/lib/follow-up-labels.ts`: add `recordHref` for projects.
- `StatusBadge` gains the `project` entity with the guide's styles.

## Out of scope

- The `PurchaseOrder` model, PO numbers, PO documents and extraction: M9. M8 ships only the project page's PO section shell.
- Invoices and anything paid/overdue: M10.
- Documents attached directly to a project.
- Tasks, milestones, time tracking, resource planning or Gantt views: not planned. Completion % is a single number the PM sets.
- Deriving completion % or status from POs or invoices.
- Several projects per quotation, or one project spanning several quotations (Decision 2).
- The PM's My Today items (projects behind schedule, follow-ups due): M11. PM dashboards and revenue reports: M12.
- Currency conversion of revenue: M12.
- MCP tools and bulk import of projects: M13.

## Acceptance criteria

**Service and data** (integration tests against the test database):

1. **AC1:** a Sales user creates a project from their `PO_RECEIVED` quotation, assigning a PM. It is `NOT_STARTED` at 0%, has the quotation's client, services, revenue and currency, a number like `PRJ-2026-0001`, and the audit log has one `Project CREATE` and one `ProjectService CREATE` per service with `source: 'web'` under one `requestId`.
2. **AC2 (validation):** rejected with field errors:
   - a quotation that is `SENT`, `UNDER_NEGOTIATION`, `LOST` or soft deleted;
   - a quotation that already has a live project;
   - a `managerId` that is not an active `PROJECT_MANAGER` (a Sales user, an admin, a deactivated PM, the system user);
   - no services, duplicates, or a newly chosen inactive service; a disabled currency that differs from the quotation's; a bad revenue (negative, too many decimals);
   - `endDate` before `startDate`; `completionPct` outside 0–100 or not an integer;
   - any `clientId`, `status`, `number`, `completedDate`, `holdReason` or `cancelReason` in the create/update input.
3. **AC3 (field rules):** the assigned PM can change completion, dates, name and description, and gets a field error for `revenue`, `currency`, `serviceIds` or `managerId`. An admin can change all of them. Services {A, B} → {B, C} writes one `DELETE` and one `CREATE`. On a `COMPLETED` or `CANCELLED` project only `description` changes. Clearing `startDate` on an `IN_PROGRESS` project is rejected.
4. **AC4 (RBAC, the "done when"):**
   - `listProjects` for a PM returns only projects where they are the manager; for Sales, only projects on quotations they own; for admins, all.
   - A PM gets not found for another PM's project and for an unassigned one. Reassigning a project from PM A to PM B removes it from A's list and adds it to B's.
   - A PM cannot create or delete projects (`ForbiddenError`). Sales cannot update, change status, reassign or delete a project, even their own (`ForbiddenError`).
   - Reassigning a quotation to another Sales rep moves its project to that rep's list.
   - Each service function has happy-path, permission-denial and audit-row tests.
5. **AC5 (PM reach into the pipeline):** a PM can read the enquiry and quotation behind their project, the follow-ups on all three, and the quotation's document; they cannot update, change status of, or delete the enquiry or quotation, nor upload or confirm the quotation document. They see nothing of an enquiry or quotation whose only project is someone else's or soft deleted. The M4 and M6 "PMs see nothing" tests are updated to these cases.
6. **AC6 (status machine, unit):** every pair of the five statuses is tested; only the nine allowed moves pass. `IN_PROGRESS` without a start date, `ON_HOLD` without a reason, `COMPLETED` without a valid completed date, and `CANCELLED` without a reason are rejected. The DB `CHECK`s reject, even via raw SQL: `COMPLETED` below 100% or with no `completedDate`, a started project with no `startDate`, `ON_HOLD` with no `holdReason`, `CANCELLED` with no `cancelReason`, `completionPct` of 101, and `endDate` before `startDate`.
7. **AC7:** starting, holding, resuming and completing each write one audited `UPDATE` with `status` and `statusChangedAt`; completing sets `completionPct = 100` and `completedDate` in the same row. `updateProject` rejects `status`; status only changes through `changeProjectStatus`. **Cancel:** an admin cancels a `NOT_STARTED`, `IN_PROGRESS` or `ON_HOLD` project with a reason in one audited `UPDATE` that keeps `completionPct` and the dates; the assigned PM and the Sales owner get `ForbiddenError`. A cancelled project cannot move to any other status, no longer matches "Behind schedule", still blocks a second project on its quotation, and shows `→ CANCELLED` with the reason on the client timeline.
8. **AC8 (quotation link):** `getProjectDraft` and `createProject` reject a quotation that already has a live project. After an admin soft-deletes the project, a new one can be created on the quotation, and restoring the old one is then rejected. `getQuotation` returns the project link.
9. **AC9 (follow-ups and timeline):** the PM logs a follow-up on their project; it appears on the client timeline for them, the Sales owner and admins, and not for another PM. The client timeline shows project creation and status changes (with hold reason and completed date) in order among quotation events, only to users who can read the project.
10. **AC10 (soft delete):** admins soft delete and restore projects (`SOFT_DELETE` / `RESTORE`). A deleted project drops out of lists except under "Deleted", its PM loses read access to the enquiry and quotation through it, and its follow-ups stay on the client timeline marked deleted.
11. **AC11 (list):** each filter (status, manager incl. unassigned, owner, client, service, quotation, currency, both date ranges, behind schedule, search by project number, name, quotation number and client name) narrows correctly; sort and pagination work; filters combine with the RBAC scope. "Behind schedule" uses today in `Asia/Kolkata` (tested around midnight IST). `listQuotations` with `hasProject: false` returns `PO_RECEIVED` quotations without a live project.
12. **AC12 (numbering):** `PRJ` numbers are sequential per year and independent of `ENQ` and `QUO`; a rolled-back create does not consume one; soft delete keeps the number.
13. **AC13 (concurrency):** two creates racing on one quotation, 10 rounds: exactly one succeeds each round, the other fails with the "already has a project" error. Racing **Mark completed** against **Put on hold**, **Mark completed** against **Cancel project**, and reassign against a status change by the old PM, 10 rounds each: the results are consistent (never `COMPLETED` with a hold reason written after it; the old PM's change fails if the reassign committed first).
14. **AC14 (seed):** `pnpm db:seed` on an M7 database adds the sample projects once, covering all five statuses and an unassigned project, and leaves at least one `PO_RECEIVED` quotation without a project.

**End-to-end (Playwright):**

15. **AC15:** a Sales user opens a `PO_RECEIVED` quotation, follows **Create project**, sees the pre-filled client, services and revenue, assigns the dev PM and saves. The quotation page now links to the project. The PM signs in, sees the project in **Projects**, starts it, sets progress to 40%, puts it on hold with a reason, resumes it and marks it completed; the list shows it completed at 100% and the timeline shows each change.
16. **AC16:** a second PM does not see the project in their list and gets a not-found page at its URL and at its quotation's URL. The Sales owner sees the project read-only (no Edit or status actions). An admin reassigns it to the second PM, who now sees it.

**Quality:**

17. **AC17:** `pnpm typecheck && pnpm lint && pnpm test` pass, `m8_projects` applies to an empty database after M7, `Project` and `ProjectService` pass the M2 audit coverage test, and the UI guide checklist is run on every new screen.

## Decisions

1. **Projects are created only from a `PO_RECEIVED` quotation**, by its Sales owner or an admin (M1 Decision 1). That is where the client, services and revenue come from, and M12 needs every project linked to a won quotation.
2. **One live project per quotation** (PLAN.md: quotation 1 → 1 project). Enforced by a partial unique index so a soft-deleted project does not block a replacement. A job the client splits into phases is one project; a second piece of work is a new enquiry.
3. **The client is fixed to the quotation's client**, for the same reason as M6 Decision 6.
4. **Sales visibility follows the quotation's current owner**, read through the relation rather than copied onto the project (M1 Decision 3's `quotationOwnerId`). Copying it would leave the old rep with access after a reassignment.
5. **The manager is optional and must be an active `PROJECT_MANAGER`.** Sales often create the project before the PM is chosen; an unassigned project is visible to admins and the Sales owner and shows in an "Unassigned" filter. Admins are not offered as managers: they already see everything, and a PM-role check keeps the PM dashboards (M12) meaningful. A deactivated PM keeps their assignments (history) but loses access through M1's `can()`; admins reassign from the list's manager filter.
6. **The PM runs delivery; admins own commercial fields.** PMs update status, completion, dates, name and description on their projects. Revenue, currency, services and the manager are admin-only after creation, because they feed M12's revenue reports and M9's PO checks and the PM is not the person accountable for them.
7. **`completedDate` is recorded on completion**, separate from the planned `endDate`, so M12 can report planned vs actual (the same reasoning as M6 Decision 8's `poReceivedDate`).
8. **Project numbers** follow M4 Decision 9: `PRJ-<YYYY>-<NNNN>` from the shared `NumberSequence` table, by the year the project is created (IST), since `startDate` may be unknown at creation.
9. **Revenue defaults to the quotation amount and may then diverge** (admins only). The quotation's amount is locked at `PO_RECEIVED` (M6 Decision 9); scope changes after the PO land on the project. The detail page shows both when they differ. Which one M12 reports as "won" is M12's call (quotation amount is the default recommendation).
10. **Completion % is set by hand.** It is not derived from invoices or POs: billing milestones rarely track delivery.
11. **`holdReason` is required for `ON_HOLD`**, so a stalled project always says why (M11/M12 surface it). It is not cleared on resume; the audit log and timeline keep each hold.
12. **Projects can be cancelled** (confirmed by the product owner). Without it, a job the client withdraws after the PO sits `ON_HOLD` forever and M12 counts its revenue as live. `CANCELLED` is reachable from `NOT_STARTED`, `IN_PROGRESS` or `ON_HOLD`, needs a `cancelReason`, and is terminal, mirroring M6 Decision 11. It is **admin-only**: dropping a project's revenue is a commercial call (Decision 6), and a PM whose project stalls puts it on hold. A cancelled project keeps its completion %, dates and revenue so M12 can report cancelled value, and it still counts as the quotation's project (a new one needs the cancelled one deleted first). The quotation stays `PO_RECEIVED`. The UI guide's badge table gains Cancelled (destructive).
13. **`COMPLETED` is terminal in v1** (confirmed by the product owner). Reopening a completed project (admins only, `COMPLETED → IN_PROGRESS`, clearing `completedDate`) can be added later without a schema change; snag work meanwhile goes in the description or a follow-up.
14. **Sales cannot edit a project after creating it** (confirmed by the product owner; M1 policy unchanged). Admins and the assigned PM handle changes.
15. **M12 reports the quotation amount as won value** by default (Decision 9); project revenue is shown alongside. M12 may revisit this with its currency decision.

## For M9 (purchase orders)

- `projectResource` and `scopeProjects` are the basis for M9's `purchaseOrder` resource: `projectManagerId = project.managerId`, `pipelineOwnerId = project.quotation.ownerId`, read through relations (Decision 4).
- `softDeleteProject` must gain "not while it has live purchase orders".
- The project page's **Purchase orders** section and the Documents tab empty state are the places M9 fills in. The PO create form should pre-fill from the project (client, services, currency, and the quotation's `poReceivedDate`).

## Dependencies

None new. Reuses M3–M7 components (DataTable, FilterBar, SummaryStrip, FormSheet patterns, StatusBadge, PipelineStrip, Money, Timeline, FollowUpSheet), `moneySchema`, `calendarDateSchema`, `requiredDay` and `nextNumber`. The progress bar is a plain styled `div` with `role="progressbar"`, not a new package.

## Risks

- **Scope queries get deeper.** PM scopes for enquiries and quotations now join through projects, and `scopeFollowUps` / `scopeDocuments` resolve ids through those (M5's risk). Measure `listFollowUps` and the client timeline on the seed; if it degrades, add the SQL view M5 suggested, still inside core.
- **`projectManagerIds` on every resource.** Every enquiry and quotation load must now select live project managers, or `can()` will deny PMs incorrectly. Put the select in the shared loaders (`findAccessible`) and cover it with AC5, not in each service function.
- **Partial unique index and Prisma.** Prisma does not model it, so `prisma migrate dev` may try to drop it on a later migration. Add a comment in `schema.prisma` and a test that the index exists (AC8 and AC13 fail without it).
- **Updating pinned tests.** The M4/M6 tests that pin "PMs see nothing" must be rewritten to the new rules, not deleted; the review should check they still cover the denied case.
- **Placeholder route.** The M6 E2E (AC16) asserts on the placeholder page; update it to the real form.
- **Role changes.** If an admin changes a PM's role to Sales (M3), their `managerId` rows stay, and they lose access through the PM scope. The list's manager filter should still show them so admins can reassign.

## Open questions

Settled by the product owner: a `CANCELLED` status, admin-only (Decision 12); `COMPLETED` stays terminal in v1 (Decision 13); Sales do not edit projects after creating them (Decision 14); admins are not offered as project managers (Decision 5); M12 reports the quotation amount as won by default (Decision 15).

None open.
