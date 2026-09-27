# M4 — Enquiries

Depends on: M0, M1, M2, M3.

## Goal

Enquiries are the first stage of the pipeline. Sales reps log every enquiry a client sends, track it until a proposal goes out, and then mark it **converted** (a quotation follows) or **lost**.

- CRUD on enquiries, with RBAC and audit logging through `packages/core`.
- A list with server-side filters (status, owner, client, sector, service, dates), search, sort and pagination.
- The enquiry status machine: `IN_PROGRESS → CONVERTED | LOST`.
- Converting produces a **quotation draft** pre-filled from the enquiry. The Quotation model arrives in M6, so M4 ships the pre-fill function and the hand-off link; M6 builds the form that consumes it.

PLAN.md "done when": converting pre-fills a new quotation.

## In scope

### Database (`packages/db`)

- **`EnquiryStatus`** enum: `IN_PROGRESS`, `CONVERTED`, `LOST`.
- **`EnquirySource`** enum: `EMAIL`, `PHONE`, `TENDER_PORTAL`, `REFERRAL`, `WEBSITE`, `WALK_IN`, `OTHER` (Decision 10).
- **`Enquiry`**:
  - `id`, `clientId` (FK `Client`), `sectorId` (FK `Sector`), `ownerId` (FK `User`).
  - `number String @unique`: the human-readable reference, e.g. `ENQ-2026-0042` (Decision 9). Assigned on create, never changed or reused.
  - `source EnquirySource` (required).
  - `sourceDetail String?`: who or where it came from, e.g. the contact's email address, the caller, the portal name and tender ID, or the referrer's name. Required when `source` is `TENDER_PORTAL`, `REFERRAL` or `OTHER`.
  - `receivedDate DateTime @db.Date` (required).
  - `proposalSentDate DateTime? @db.Date`.
  - `status EnquiryStatus @default(IN_PROGRESS)`.
  - `description String?`: what the client asked for, free text.
  - `lostReason String?`: required when `LOST` (Decision 4).
  - `statusChangedAt DateTime?`: set by the status machine; M11 and M12 use it.
  - `createdAt`, `updatedAt`, `deletedAt DateTime?` (soft-deletable, so M3's extension filters it).
  - Indexes: `(ownerId, status)`, `(clientId)`, `(status, receivedDate)` (the last one for M11's "stale enquiries"), `(source)`.
- **`NumberSequence`** (reusable counter, Decision 9):
  - `key String @id` (e.g. `ENQ-2026`), `lastValue Int`, `updatedAt`.
  - Not soft-deletable. Incremented with an atomic `upsert … increment` inside the caller's `withTx`, so the row lock serialises concurrent creates and a rolled-back create does not consume a number.
  - A core helper `nextNumber(tx, prefix, year)` returns the formatted value. M6 (quotation numbers) can reuse it.
- **`EnquiryService`** (explicit join, Decision 2):
  - `id`, `enquiryId` (FK), `serviceId` (FK), `createdAt`.
  - `@@unique([enquiryId, serviceId])`.
  - **Not** soft-deletable: removing a service from an enquiry is a hard `DELETE`, recorded by M2 as `DELETE` with the `before` row.
- Back-relations on `Client`, `Sector`, `Service` and `User`.
- A `CHECK (proposalSentDate IS NULL OR proposalSentDate >= receivedDate)` in the migration SQL, and `CHECK (status <> 'CONVERTED' OR "proposalSentDate" IS NOT NULL)` as the final guard for the status rule.
- Both models are audited automatically; the M2 coverage test must pass.
- Migration: `m4_enquiries`.

### RBAC (`packages/core/rbac`)

- The `enquiry` policy rule already exists (M1). No change to `policy.ts`.
- Add **`scopeEnquiries(user)`** to `rbac/scope.ts`:
  - `ADMIN`: `{}`.
  - `SALES`: `{ ownerId: user.id }`.
  - `PROJECT_MANAGER`: enquiries linked to a project they manage. No projects exist until M8, so M4 returns a filter that matches nothing (`{ id: { in: [] } }`), with a `TODO(M8)` and a test that pins today's behaviour.
- Services build the instance as `{ type: 'enquiry', ownerId, projectManagerIds: [] }`. A single helper `enquiryResource(row)` does this, so M8 changes one place.

### Status machine (`packages/core/status/enquiry.ts`)

- Pure functions, no database access:
  - `canTransitionEnquiry(from, to): boolean`.
  - `assertEnquiryTransition(enquiry, to, input)`: throws `DomainError` with a field when a rule fails.
- Allowed moves: `IN_PROGRESS → CONVERTED`, `IN_PROGRESS → LOST`. Everything else is rejected, including `CONVERTED → LOST`, `LOST → IN_PROGRESS` and same-state moves (Decision 5).
- `CONVERTED` requires `proposalSentDate` (the stored value or one supplied with the action).
- `LOST` requires a non-empty `lostReason`.
- Exported from `packages/core/status/index.ts`.

### Schemas (`packages/core/schemas/enquiry.ts`)

- `createEnquirySchema`: `clientId`, `sectorId`, `serviceIds` (1–10 unique ids), `receivedDate`, `source`, `sourceDetail?` (≤ 200; required for `TENDER_PORTAL`, `REFERRAL`, `OTHER` via a Zod refinement with the field path), `proposalSentDate?`, `description?` (≤ 2000), `ownerId?` (admin only; see service).
- `updateEnquirySchema`: the same fields, all optional. **No `status` or `number` field** (CLAUDE.md rule 8; numbers are immutable). The source-detail rule is checked against the merged record in the service, since an update may change only one of the two fields. Empty string clears optional fields, `undefined` leaves them unchanged (the M3 convention).
- `convertEnquirySchema`: `{ id, proposalSentDate? }`.
- `markEnquiryLostSchema`: `{ id, lostReason }` (1–500 chars).
- `listEnquiriesSchema`: `listParamsSchema` plus `status[]`, `source[]`, `ownerId`, `clientId`, `sectorId`, `serviceId`, `receivedFrom/To`, `proposalSentFrom/To`, `recordStatus` (live/deleted). `q` searches enquiry number, client name, description and source detail. Sortable columns: `receivedDate` (default, desc), `number`, `proposalSentDate`, `status`, `source`, `client`, `owner`, `updatedAt`.
- Dates are ISO `YYYY-MM-DD` strings in input, parsed to UTC midnight for `@db.Date`. `receivedDate` cannot be in the future (today in `Asia/Kolkata`). `proposalSentDate ≥ receivedDate` and not in the future.
- Action-input shapes (`withId(...)`, `idOnlySchema`) also live in core, as in M3.

### Services (`packages/core/services/enquiry.service.ts`)

Each function takes `ctx`, validates with the schema, calls `assertCan`, and writes inside `withTx`.

- `listEnquiries(ctx, input)`: `assertCan(ctx, 'list', 'enquiry')`, then `scopeEnquiries` ANDed with the filters. Returns `Page<EnquiryRow>` with client, sector, owner and service names.
- `getEnquiry(ctx, id)`: loads the ownership fields, `assertCan(ctx, 'read', …)`, returns the detail (retired or deleted masters still show their names, like M3 AC12). Not visible → `NotFoundError`, not `ForbiddenError`, so ids of other reps' enquiries don't leak.
- `createEnquiry(ctx, input)`:
  - `ownerId` defaults to `ctx.user.id`. Only admins may set another owner, and it must be an active `SALES` or `ADMIN` user.
  - `clientId` must be a live client. `sectorId` and every `serviceId` must be live and active.
  - `sectorId` defaults in the UI to the client's sector but is stored per enquiry (editable).
  - Assigns `number` with `nextNumber(tx, 'ENQ', year of receivedDate)` in the same transaction.
  - Creates the `Enquiry` row, then one `EnquiryService` row per service, as separate writes (M2 rejects nested writes).
- `updateEnquiry(ctx, id, input)`:
  - `assertCan(ctx, 'update', …)`.
  - Allowed in any status (corrections), except that `proposalSentDate` cannot be cleared on a `CONVERTED` enquiry.
  - `number` never changes, even if `receivedDate` moves to another year.
  - `source` and `sourceDetail` are editable; the source-detail rule is checked on the merged values.
  - Masters are re-checked only when they **change** (the M3 retired-sector fix).
  - Services are diffed: removed ones deleted, added ones created; unchanged rows untouched.
  - Changing `ownerId` is admin only (reassignment).
- `convertEnquiry(ctx, input)`: `update` permission, status machine, sets `status`, `statusChangedAt` and (if supplied) `proposalSentDate` in one update. Returns the enquiry plus `quotationDraft` (below).
- `markEnquiryLost(ctx, input)`: `update` permission, status machine, sets `status`, `lostReason`, `statusChangedAt`.
- `softDeleteEnquiry` / `restoreEnquiry`: `delete` permission. Only `IN_PROGRESS` and `LOST` enquiries can be deleted (Decision 6).
- `getQuotationDraft(ctx, enquiryId)`: `read` permission; requires `CONVERTED`. Returns `{ enquiryId, clientId, sectorId, serviceIds, ownerId, quotationDate: proposalSentDate }`. This is the contract M6's create-quotation form reads (CLAUDE.md: quotation date defaults to the enquiry's proposal sent date). It is typed by a `quotationDraftSchema` in core so M6 validates against the same shape.

### Seed

- Development only: 8–10 enquiries across the sample clients, sectors and services, owned by the seeded sales users, covering all three statuses, every source, and a spread of received dates (including some older than 30 days for M11). They get numbers from the same sequence as real enquiries.
- Written through the service functions under `systemCtx()`, so they are audited as `system`.
- The dev seed adds one or two sample clients if M3's seed has none.

### Web (`apps/web`)

- Main nav gets **Enquiries**, shown when `can(user, 'list', 'enquiry')`.
- **`/enquiries`** (list):
  - TanStack Table, server-side, URL search params (the M3 pattern).
  - Columns: number (links to detail), received date, client, sector, services, source, owner, status badge, proposal sent date, updated.
  - Filters: status (multi), source (multi), owner (admins only; Sales always see their own), client, sector, service, received date range, proposal-sent date range, search (number, client name, description, source detail), "Deleted" view with Restore.
  - "New enquiry" button when `can(user, 'create', 'enquiry')`.
- **`/enquiries/new`** and **`/enquiries/[id]/edit`**:
  - React Hook Form + `zodResolver` with the core schemas; server actions via M1's `action()` wrapper.
  - Client picker (live clients); picking one pre-selects its sector.
  - "New client" opens a dialog using M3's `createClient` (with an optional primary contact), for users who may create clients.
  - Sector and service pickers use `listOptions`; retired values already on the enquiry stay visible.
  - Source select plus a source-detail field whose label and placeholder follow the source (e.g. "Portal and tender ID" for `TENDER_PORTAL`, "Referred by" for `REFERRAL`). It is marked required for the sources that need it.
  - Owner picker for admins only.
  - The number is not an input; it appears after saving (and read-only on edit).
  - Dates shown and entered in `Asia/Kolkata`.
- **`/enquiries/[id]`** (detail):
  - The enquiry number as the page title, then fields, source and detail, status, lost reason, created/updated times.
  - Actions by status and permission:
    - `IN_PROGRESS`: **Convert** (dialog asks for proposal sent date if missing) and **Mark lost** (dialog requires a reason).
    - `CONVERTED`: a **Create quotation** link to `/quotations/new?enquiryId=<id>`. Until M6 ships, that route renders a placeholder page showing the draft values from `getQuotationDraft`, so the hand-off is testable now.
  - Edit, Delete (confirmation dialog).
  - A small "History" panel reusing the M3 audit viewer component filtered to this enquiry (admins, and the owner for their own changes per M2 scoping). The full timeline is M5.

## Out of scope

- Quotation model, form and status machine: M6. (M4 only provides `getQuotationDraft` and the placeholder route.)
- Follow-ups on enquiries and the per-client timeline: M5.
- Attaching documents to enquiries: not planned (documents attach to quotations, POs and invoices).
- Project-manager visibility of enquiries: wired in M8, when projects exist.
- Bulk import and MCP tools (`search_enquiries`, `create_enquiry`): M13.
- Stale-enquiry alerts: M11.

## Acceptance criteria

**Service and data** (integration tests against the test database):

1. **AC1:** a Sales user creates an enquiry with a client, sector, two services, a received date and a source. It is `IN_PROGRESS`, owned by them, has a number like `ENQ-2026-0001`, and the audit log has one `Enquiry CREATE` and two `EnquiryService CREATE` rows with `source: 'web'`, grouped by one `requestId`.
2. **AC2 (validation):** these are rejected with field errors:
   - no services, or duplicate service ids;
   - a future `receivedDate`;
   - `proposalSentDate` before `receivedDate`;
   - a deleted client, or an inactive/deleted sector or service;
   - a non-admin setting `ownerId`;
   - no source, or `TENDER_PORTAL` / `REFERRAL` / `OTHER` without source detail (on create, and on an update that switches the source without supplying detail).
3. **AC3:** updating an enquiry writes one `UPDATE` row with the right `changedFields`. Changing services from {A, B} to {B, C} writes one `DELETE` (A) and one `CREATE` (C) and leaves B untouched. Editing only the description of an enquiry whose sector was since retired succeeds.
4. **AC4 (RBAC):**
   - A Sales user cannot read, update, convert, mark lost or delete another rep's enquiry; `getEnquiry` returns not found.
   - `listEnquiries` for Sales returns only their own; for admins, all; for project managers, none (pinned until M8).
   - Only admins can reassign an owner, and only to an active Sales or Admin user.
   - Each service function has a happy-path, permission-denial and audit-row test.
5. **AC5 (status machine, unit):** every pair of statuses is tested. Only `IN_PROGRESS → CONVERTED` and `IN_PROGRESS → LOST` are allowed. `CONVERTED` without a proposal sent date and `LOST` without a reason are rejected.
6. **AC6 (convert):** converting an `IN_PROGRESS` enquiry with a proposal sent date sets `CONVERTED` and `statusChangedAt`, writes one audited `UPDATE`, and returns a `quotationDraft` whose client, sector, services, owner and `quotationDate` (= proposal sent date) match the enquiry. **This is the PLAN.md "done when" test.** Supplying the date in the convert call stores it in the same update.
7. **AC7 (lost):** marking lost stores the reason and `statusChangedAt`. A lost enquiry cannot be converted.
8. **AC8:** `updateEnquiry` ignores or rejects a `status` field; status only changes through convert / mark lost. The DB `CHECK` rejects a `CONVERTED` row without `proposalSentDate` even via raw SQL.
9. **AC9 (soft delete):** `IN_PROGRESS` and `LOST` enquiries can be soft deleted and restored (`SOFT_DELETE` / `RESTORE` rows). Deleting a `CONVERTED` enquiry is rejected. Deleted enquiries are hidden from lists except under the "Deleted" filter.
10. **AC10 (list):** each filter (status, owner, client, sector, service, both date ranges, search) narrows results correctly; sort and pagination work; filters combine with the RBAC scope (a Sales user filtering by another owner gets nothing).
11. **AC11:** `getQuotationDraft` returns the draft for a converted enquiry the user can read and rejects one that is not `CONVERTED`.
12. **AC12 (numbering):**
    - Numbers are sequential per year of `receivedDate`: the first 2026 enquiry is `ENQ-2026-0001`, the next `ENQ-2026-0002`, and a backdated 2025 enquiry gets `ENQ-2025-0001` independently.
    - 20 enquiries created concurrently get 20 distinct, gap-free numbers.
    - A create that fails validation or rolls back does not consume a number.
    - Soft deleting an enquiry keeps its number; the next create does not reuse it.
    - `updateEnquiry` cannot change the number, including when `receivedDate` moves to another year.
    - Past 9999 the counter widens (`ENQ-2026-10000`) instead of failing.
13. **AC13 (source):** source and detail are stored, editable and audited; the list filters by one or more sources; search finds an enquiry by its source detail (e.g. a tender ID) and by its number.

**End-to-end (Playwright):**

14. **AC14:** a Sales user signs in, creates an enquiry from a tender portal (creating a new client inline), sees its `ENQ-…` number, marks the proposal sent, converts it, follows **Create quotation**, and sees the placeholder page with the pre-filled client, services and quotation date.
15. **AC15:** a second Sales user does not see that enquiry in their list and gets a not-found page at its URL. An admin sees it, finds it by number in the search box, and can reassign it.

**Quality:**

16. **AC16:** `pnpm typecheck && pnpm lint && pnpm test` pass, `m4_enquiries` applies to an empty database, and all new models pass the M2 audit coverage test.

## Decisions

1. **Terminology:** "enquiry" (British spelling) everywhere: model, routes, UI.
2. **An enquiry can cover several services** (confirmed by the product owner; settles the PLAN.md open question for M4). Stored in an explicit `EnquiryService` join model rather than a Prisma implicit many-to-many, because implicit relations are written as nested writes, which M2 rejects and would not audit per row.
3. **Sector is stored on the enquiry**, defaulted from the client's sector. A client can buy for a different business line, and reports (M12) group by the enquiry's sector.
4. **`lostReason` is required when marking lost.** It is a schema addition beyond PLAN.md, added because M12's win/loss analysis needs it and it costs one field.
5. **`CONVERTED` and `LOST` are terminal** (confirmed by the product owner for v1). No reopening; a mistaken status is fixed by an admin creating a new enquiry. Adding `LOST → IN_PROGRESS` later is a one-line machine change plus tests.
6. **Converted enquiries cannot be deleted,** because M6 quotations will point to them. Lost and in-progress ones can.
7. **Not-visible reads return not found,** so a Sales user cannot probe other reps' enquiry ids.
8. **The quotation hand-off is a typed draft, not a Quotation row.** Conversion never creates a quotation silently; the user confirms it on the M6 form. M4 defines `quotationDraftSchema` so both modules share one contract.
9. **Enquiry numbers** (confirmed by the product owner): `ENQ-<YYYY>-<NNNN>`, unique, sequential per calendar year of `receivedDate` (in IST), zero-padded to four digits and widening past 9999.
   - Assigned in the create transaction from a `NumberSequence` counter row, not a Postgres `SEQUENCE`: sequences can't reset per year and don't roll back, which would leave gaps.
   - Immutable and never reused, including after soft delete. The `id` (uuid) stays the primary key and URL segment; the number is for people.
   - Calendar year, not the Indian financial year (April–March), confirmed by the product owner.
10. **Enquiry source** (confirmed by the product owner): a required `source` enum plus free-text `sourceDetail`.
    - The enum holds the four requested channels (email, phone, tender portal, referral) plus `WEBSITE`, `WALK_IN` and `OTHER`, so every enquiry has a home without free-text sprawl. An enum rather than a master table: channels change rarely and M12 groups by them.
    - Detail is required where the channel alone is not enough to follow up: tender portal (portal and tender ID), referral (who referred), other (what it was).
    - M12 reports conversion by source; M13's import maps a source column to the enum.

## Dependencies

None new. Tables, forms, dialogs, badges and toasts reuse what M3 added (`@tanstack/react-table`, shadcn components, `sonner`). A date-range filter is built from two native `<input type="date">` fields; no date-picker library.

## Risks

- **Hard delete of `EnquiryService` under M2/M3 extensions:** confirm that `deleteMany` on a non-soft-deletable model is audited per row (one `DELETE` each with `before`). If M2 only supports single-row `delete`, the service deletes rows one at a time.
- **`@db.Date` and time zones:** a date entered as `2026-09-27` in IST must be stored as `2026-09-27`, not the previous day. Parse input as a calendar date (UTC midnight) and never through `new Date(localString)`. "Today" for the future-date check is computed in `Asia/Kolkata`. Test both around midnight IST.
- **Filtering by service** needs `services: { some: { serviceId } }`; check the soft-delete extension doesn't interfere, since `EnquiryService` has no `deletedAt`.
- **`NumberSequence` and the audit log:** the M2 coverage test expects every model to be audited, so each create would also log a counter `UPDATE`. Planning should decide whether to accept that (it's harmless and shows the number assignment) or add `NumberSequence` to an explicit audit-exempt list with a comment. Either way the counter must be written through the transaction client inside `withTx`.
- **Concurrent numbering:** `upsert` with `increment` can race on the _first_ insert of a new year's key (two transactions both try to create it). Handle the unique-violation by retrying the increment once, and cover it in the AC12 concurrency test.
- **Search on client name** crosses a relation; confirm the query plan is acceptable on seeded volumes, or add a trigram index later (M14).

## Open questions

Settled by the product owner: multi-service enquiries (Decision 2), no reopening in v1 (Decision 5), human-readable numbers per calendar year (Decision 9), and recording the enquiry source (Decision 10).

None remaining.
