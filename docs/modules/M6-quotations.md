# M6 — Quotations

Depends on: M0, M1, M2, M3, M4, M5.

## Goal

A quotation is the priced proposal sent to a client after an enquiry converts. Sales reps create it from the converted enquiry, record the amount and currency, and chase it with follow-ups until the client either negotiates or sends a purchase order.

- CRUD on quotations, created from a `CONVERTED` enquiry using M4's `quotationDraft`, with RBAC and audit logging through `packages/core`.
- Amount stored as integer minor units plus an ISO currency code from `CompanySettings.enabledCurrencies`.
- The quotation status machine: `SENT ⇄ UNDER_NEGOTIATION → PO_RECEIVED | LOST`, with `nextFollowUpDate` required while `SENT` or `UNDER_NEGOTIATION` and a reason required for `LOST` (Decision 11).
- `nextFollowUpDate` and `lastFollowUpHighlights` kept in sync with the latest follow-up logged on the quotation (M5 Decision 6).
- Reaching `PO_RECEIVED` produces a **project draft**. The Project model arrives in M8, so M6 ships the draft function and the hand-off link; M8 builds the form that consumes it (the same pattern as M4 → M6).
- Replaces M4's placeholder `/quotations/new` page with the real form.

PLAN.md "done when": PO_RECEIVED prompts project creation.

## In scope

### Database (`packages/db`)

- **`QuotationStatus`** enum: `SENT`, `UNDER_NEGOTIATION`, `PO_RECEIVED`, `LOST`.
- **`Quotation`**:
  - `id`, `enquiryId` (FK `Enquiry`), `clientId` (FK `Client`), `sectorId` (FK `Sector`), `ownerId` (FK `User`).
  - `number String @unique`: e.g. `QUO-2026-0042`, from M4's `nextNumber(tx, 'QUO', year)` (Decision 7). Assigned on create, never changed or reused.
  - `quotationDate DateTime @db.Date` (required). Defaults in the form to the enquiry's `proposalSentDate`.
  - `amountMinor BigInt` and `currency String` (3-letter ISO code). See Decision 3 on `BigInt`.
  - `status QuotationStatus @default(SENT)`.
  - `nextFollowUpDate DateTime? @db.Date`: required while `SENT` or `UNDER_NEGOTIATION` (enforced in the status machine, the service and a DB `CHECK`).
  - `lastFollowUpHighlights String?`: up to 1000 chars; synced from the latest follow-up, editable by hand (Decision 5).
  - `lastFollowUpId String?`: the follow-up the two fields above were last synced from (no FK; follow-ups are soft-deleted, not removed). Lets the sync tell "newer follow-up" from "older one edited".
  - `poReceivedDate DateTime? @db.Date`: required when `PO_RECEIVED` (Decision 8).
  - `lostReason String?`: required when `LOST` (Decision 11), 1–500 chars.
  - `description String?`: scope summary or notes, ≤ 2000 chars.
  - `statusChangedAt DateTime?`: set by the status machine; M11 and M12 use it.
  - `createdAt`, `updatedAt`, `deletedAt DateTime?` (soft-deletable).
  - Indexes: `(ownerId, status, nextFollowUpDate)` (M11 "quotations awaiting reply" and due follow-ups), `(enquiryId)`, `(clientId)`, `(status, quotationDate)`.
- **`QuotationService`** (explicit join, as M4 Decision 2):
  - `id`, `quotationId` (FK), `serviceId` (FK), `createdAt`.
  - `@@unique([quotationId, serviceId])`. Not soft-deletable; removal is a hard `DELETE`, audited with the `before` row.
- Back-relations on `Enquiry`, `Client`, `Sector`, `Service` and `User`.
- `CHECK` constraints in the migration SQL:
  - `"amountMinor" >= 0`.
  - `"currency" ~ '^[A-Z]{3}$'`.
  - `status NOT IN ('SENT','UNDER_NEGOTIATION') OR "nextFollowUpDate" IS NOT NULL`.
  - `status <> 'PO_RECEIVED' OR "poReceivedDate" IS NOT NULL`.
  - `"poReceivedDate" IS NULL OR "poReceivedDate" >= "quotationDate"`.
  - `status <> 'LOST' OR "lostReason" IS NOT NULL`.
- Both models are audited automatically; the M2 coverage test must pass. Confirm the audit snapshot serialises `BigInt` (see Risks).
- Migration: `m6_quotations`.

### RBAC (`packages/core/rbac`)

- The `quotation` policy rule already exists (M1): Sales CRUD their own, PMs read on their projects. No change to `policy.ts`.
- **`scopeQuotations(user)`** in `rbac/scope.ts`:
  - `ADMIN`: `{}`.
  - `SALES`: `{ ownerId: user.id }`.
  - `PROJECT_MANAGER`: matches nothing until M8 (`{ id: { in: [] } }`), with a `TODO(M8)` and a test pinning today's behaviour, as M4 did for enquiries.
- **`quotationResource(row)`** builds `{ type: 'quotation', ownerId, projectManagerIds: [] }`. One place for M8 to change.
- Creating a quotation also needs `read` on the source enquiry (checked with `enquiryResource`) before `assertCan(ctx, 'create', quotationResource(...))` on the new owner.
- **`scopeFollowUps`** gains a `QUOTATION` branch; `visible` becomes `{ ENQUIRY, QUOTATION }`.

### Status machine (`packages/core/status/quotation.ts`)

- Pure functions, no database access:
  - `canTransitionQuotation(from, to): boolean`.
  - `assertQuotationTransition(quotation, to, input)`: throws `DomainError` with a field when a rule fails.
- Allowed moves: `SENT → UNDER_NEGOTIATION`, `UNDER_NEGOTIATION → SENT`, `SENT → PO_RECEIVED`, `UNDER_NEGOTIATION → PO_RECEIVED`, `SENT → LOST`, `UNDER_NEGOTIATION → LOST`. Everything else is rejected, including same-state moves and anything out of `PO_RECEIVED` or `LOST` (both terminal; Decisions 9 and 11).
- Moving to `SENT` or `UNDER_NEGOTIATION` requires a `nextFollowUpDate` (stored, or supplied with the action).
- Moving to `PO_RECEIVED` requires `poReceivedDate` (supplied with the action), not in the future and not before `quotationDate`.
- Moving to `LOST` requires a non-empty `lostReason`.
- Exported from `packages/core/status/index.ts`.

### Schemas (`packages/core/schemas/quotation.ts`)

- **Money input:** a shared `moneySchema` in `schemas/money.ts`: `{ amount: string, currency: string }` → `{ amountMinor: bigint, currency }`.
  - `amount` is a decimal string (`"125000.50"`, commas allowed and stripped). It is parsed by string splitting, never through `Number`/`parseFloat` (CLAUDE.md rule 5).
  - Fraction digits come from `Intl.NumberFormat('en-IN', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits` (INR/USD 2, JPY 0, KWD 3). More decimals than the currency allows → field error.
  - `amount ≥ 0`, at most 15 integer digits. Zero is allowed (Decision 4).
  - A `formatMoney(amountMinor, currency)` helper in core (shared with the web app) formats with `Intl.NumberFormat('en-IN', …)`, and `toAmountString(amountMinor, currency)` fills edit forms. M9 and M10 reuse all three.
- `createQuotationSchema`: `enquiryId`, `quotationDate`, `amount`, `currency`, `serviceIds` (1–10 unique), `sectorId`, `nextFollowUpDate`, `description?`, `lastFollowUpHighlights?`, `ownerId?` (admin only). **No `clientId`** (taken from the enquiry; Decision 6) and no `status` (always starts `SENT`).
- `updateQuotationSchema`: the same fields except `enquiryId`, all optional. **No `status`, `number`, `clientId`, `poReceivedDate` or `lostReason`.** Empty string clears optional fields, `undefined` leaves them unchanged (M3 convention). `nextFollowUpDate` cannot be cleared while the quotation is active (checked on merged values in the service).
- `changeQuotationStatusSchema`: discriminated on `to`:
  - `{ id, to: 'UNDER_NEGOTIATION' | 'SENT', nextFollowUpDate? }`.
  - `{ id, to: 'PO_RECEIVED', poReceivedDate }`.
  - `{ id, to: 'LOST', lostReason }` (1–500 chars).
- `listQuotationsSchema`: `listParamsSchema` plus `status[]`, `ownerId`, `clientId`, `enquiryId`, `sectorId`, `serviceId`, `currency[]`, `quotationFrom/To`, `nextFollowUpFrom/To`, `followUpDue` (boolean: active, i.e. `SENT` or `UNDER_NEGOTIATION`, and `nextFollowUpDate ≤ today` IST), `recordStatus`. `q` searches quotation number, enquiry number, client name, description and lost reason. Sortable: `quotationDate` (default, desc), `number`, `amount` (within the filtered set; mixed currencies sort by minor units, noted in the UI), `status`, `nextFollowUpDate`, `client`, `owner`, `updatedAt`.
- `projectDraftSchema` (for M8): `{ quotationId, quotationNumber, clientId, serviceIds, ownerId, revenueMinor, currency, poReceivedDate }`.
- Dates use M4's `calendarDateSchema`. `quotationDate`: not in the future (today in `Asia/Kolkata`), not before the enquiry's `receivedDate`. `nextFollowUpDate`: on or after `quotationDate`; may be in the past (back-filling, imports; same reasoning as M5's implementation note).
- Action-input shapes (`withId(...)`, `idOnlySchema`) live in core.

### Services (`packages/core/services/quotation.service.ts`)

Each function takes `ctx`, validates with the schema, calls `assertCan`, and writes inside `withTx`. Status and delete writes are conditional `updateMany` calls that re-check the status and `deletedAt` that were read (the M4/M5 code-review fix); a request that loses the race fails with "Someone else changed this quotation".

- `listQuotations(ctx, input)`: `assertCan(ctx, 'list', 'quotation')`, `scopeQuotations` ANDed with filters. Returns `Page<QuotationRow>` with enquiry number, client, sector, owner and service names, formatted amount.
- `getQuotation(ctx, id)`: not visible → `NotFoundError` (M4 Decision 7). Includes the enquiry number, services, and for `PO_RECEIVED` the `projectDraft` availability.
- `createQuotation(ctx, input)`:
  - Enquiry must be live, readable and `CONVERTED`; otherwise not found (unreadable) or `DomainError` on `enquiryId`.
  - `clientId` copied from the enquiry. `ownerId` defaults to the enquiry's owner; only admins may set another active `SALES` or `ADMIN` user. A Sales user creating on their own enquiry becomes the owner.
  - `sectorId` and every `serviceId` must be live and active. `currency` must be in `CompanySettings.enabledCurrencies`.
  - Assigns `number` with `nextNumber(tx, 'QUO', year of quotationDate)`.
  - Creates the `Quotation` row (status `SENT`, `statusChangedAt = now`), then one `QuotationService` row per service, as separate writes (M2 rejects nested writes).
  - Several quotations per enquiry are allowed (PLAN.md: enquiry 1 → many quotations).
- `updateQuotation(ctx, id, input)`:
  - `update` permission. Allowed in `SENT` and `UNDER_NEGOTIATION`. In `PO_RECEIVED` and `LOST` only `description` and `lastFollowUpHighlights` may change (a won amount becomes the project's revenue, a lost one is what M12 reports as lost value; Decisions 9 and 11).
  - Edited in place; the audit log is the revision history (Decision 2). A formally re-issued quotation can instead be a new quotation on the same enquiry.
  - Masters and currency re-checked only when they **change** (the M3 retired-sector fix; a quotation in a since-disabled currency stays editable).
  - Services diffed as in M4. Owner change is admin only.
- `changeQuotationStatus(ctx, input)`: `update` permission, status machine, then one update setting `status`, `statusChangedAt` and the supplied `nextFollowUpDate`, `poReceivedDate` or `lostReason`. For `PO_RECEIVED`, returns the quotation plus `projectDraft`. `nextFollowUpDate` is kept (not cleared) on `PO_RECEIVED` and `LOST`; M11 ignores it outside the active statuses.
- `softDeleteQuotation` / `restoreQuotation`: `delete` permission. `SENT`, `UNDER_NEGOTIATION` and `LOST` quotations can be deleted; `PO_RECEIVED` ones cannot (a project will point at them, as M4 Decision 6). Restoring requires the enquiry to be live.
- `getProjectDraft(ctx, quotationId)`: `read` permission; requires `PO_RECEIVED`. Returns the `projectDraftSchema` shape. This is the contract M8's create-project form reads.
- `listQuotationsForEnquiry(ctx, enquiryId)`: for the enquiry page; applies `scopeQuotations`.

**Follow-up sync** (`packages/core/services/follow-up-targets.ts` and `follow-up.service.ts`):

- Add a `QUOTATION` entry to `FOLLOW_UP_TARGETS`: `auditModel: 'Quotation'`, `load` (label = quotation number; resource = `quotationResource`), `visibleIds`, `labels`, `pickable`.
- Extend the registry hook from `afterLog` to **`afterChange(db, followUp, kind)`**, called in the same transaction on log, update, soft delete and restore. For quotations it recomputes from the latest live follow-up (by `date`, then `createdAt`, as `getLatestFollowUp`):
  - `lastFollowUpHighlights` ← that follow-up's notes (first 1000 chars); `lastFollowUpId` ← its id.
  - `nextFollowUpDate` ← its `nextFollowUpDate` when set; otherwise unchanged.
  - If no live follow-up remains, both fields keep their current values (the required date is never cleared by a delete).
  - Only writes when a value actually changes, so the audit log shows a `Quotation UPDATE` with `source` matching the follow-up's (Decision 5).
  - Only active quotations sync `nextFollowUpDate`; a follow-up on a `PO_RECEIVED` or `LOST` quotation updates highlights only.
- `logFollowUp` on an active quotation **requires** `nextFollowUpDate` (field error), since the quotation must always have one.
- `timeline.service` picks up quotation `CREATED`, `STATUS_CHANGE` (showing `SENT → UNDER_NEGOTIATION` etc.), `DELETED` and `RESTORED` events through the registry with no other change. Status summaries whitelist `poReceivedDate` and `lostReason`; amounts are not shown on the timeline.

**Enquiry side:** `getQuotationDraft` (M4) is unchanged. `softDeleteEnquiry` is already blocked for `CONVERTED`, so no quotation can lose its enquiry.

### Seed

- Development only: one or two quotations for most sample `CONVERTED` enquiries, covering all four statuses (lost ones with a reason), INR and USD (the seed enables USD in settings if needed), amounts from ₹45,000 to ₹3.5 crore (exercises `BigInt`), and next follow-up dates missed, due today and upcoming (for M11).
- Some sample follow-ups are logged on the quotations so highlights are populated through the real sync.
- Written through the services in the same all-or-nothing seed transaction as M4/M5, as the owning sales user with `source: 'system'`. Added when no quotations exist, even if enquiries do (the M5 pattern).

### Web (`apps/web`)

- Main nav gets **Quotations**, shown when `can(user, 'list', 'quotation')`.
- **`/quotations`** (list): TanStack Table, server-side, URL search params (the M3 pattern).
  - Columns: number (links to detail), quotation date, enquiry number, client, services, amount (formatted in its own currency), status badge, next follow-up (highlighted red when past, amber when today), owner, updated.
  - Filters: status (multi), owner (admins only), client, sector, service, currency, quotation date range, next follow-up range, "Follow-up due" toggle, search, "Deleted" view with Restore.
  - No "New quotation" button: quotations start from a converted enquiry.
- **`/quotations/new?enquiryId=…`** (replaces the M4 placeholder) and **`/quotations/[id]/edit`**:
  - React Hook Form + `zodResolver` with the core schemas, raw values (M4 note); server actions via M1's `action()`.
  - Pre-filled from `getQuotationDraft`: client (read-only), sector, services, owner (admins only), quotation date.
  - Amount field (text, `inputMode="decimal"`) with a currency select limited to enabled currencies, defaulting to INR. The formatted value shows under the field as the user types.
  - Next follow-up date with quick picks (+3 days, +1 week, +2 weeks), required.
  - Highlights textarea (optional on create).
  - The number is not an input; it appears after saving.
- **`/quotations/[id]`** (detail):
  - Number as title, the enquiry link, fields, formatted amount, status badge, PO received date or lost reason when set, next follow-up date, last follow-up highlights (with "from follow-up on <date>" when synced).
  - Actions by status and permission:
    - `SENT`: **Mark under negotiation**, **PO received**, **Mark lost**.
    - `UNDER_NEGOTIATION`: **Back to sent**, **PO received**, **Mark lost**.
    - Status dialogs ask for the next follow-up date (pre-filled with the current one), the PO received date, or the lost reason (required).
    - `LOST`: the lost reason is shown under the status badge; no status actions.
    - `PO_RECEIVED`: a **Create project** link to `/projects/new?quotationId=<id>`. Until M8 ships, that route renders a placeholder showing the `getProjectDraft` values, so the hand-off is testable now. After the transition the page shows a prompt banner with the same link (**the "done when"**).
  - Record timeline (M5 component narrowed to the quotation) and **Log follow-up** (next date required while active).
  - Edit (limited fields for `PO_RECEIVED` and `LOST`), Delete (confirmation dialog; hidden for `PO_RECEIVED`).
- **`/enquiries/[id]`**: a **Quotations** section listing the enquiry's quotations (number, date, amount, status). The **Create quotation** link stays for `CONVERTED` enquiries, including when quotations exist.
- **`/clients/[id]`**: a **Quotations** tab (the list filtered to the client, respecting scope). The timeline record filter includes quotations (`?record=QUOTATION:<id>`).
- `apps/web/lib/follow-up-labels.ts`: add `recordHref` for quotations.

## Out of scope

- Attaching the quotation document (PDF) and AI extraction: M7 adds `documentId` and the upload.
- The Project model and the real create-project form: M8 (M6 provides `getProjectDraft` and the placeholder route).
- PO numbers and PO records: M8/M9 (PLAN.md: entered on the project after `PO_RECEIVED`).
- Project-manager visibility of quotations: wired in M8.
- Currency conversion to INR for reports: M12 (open question in PLAN.md).
- Line items, tax/GST breakdown, discounts and generating a quotation PDF from the app: not planned (Decision 10).
- Reminders for due quotation follow-ups and the My Today view: M11.
- MCP tools and bulk import of quotations: M13.

## Acceptance criteria

**Service and data** (integration tests against the test database):

1. **AC1:** a Sales user creates a quotation from their `CONVERTED` enquiry with amount `"1,25,000.50"` INR, two services and a next follow-up date. It is `SENT`, owned by them, has `amountMinor = 12500050n`, `currency = 'INR'`, client = the enquiry's client, a number like `QUO-2026-0001`, and the audit log has one `Quotation CREATE` and two `QuotationService CREATE` rows with `source: 'web'` under one `requestId`.
2. **AC2 (validation):** rejected with field errors:
   - an enquiry that is `IN_PROGRESS` or `LOST`, or soft deleted;
   - a currency not in `enabledCurrencies`, or not a valid ISO code;
   - a negative amount, a non-numeric amount, more decimals than the currency allows (`"10.5"` JPY, `"10.123"` INR), more than 15 integer digits;
   - no services, or duplicates; an inactive or deleted sector or service;
   - a future `quotationDate`, or one before the enquiry's `receivedDate`;
   - a missing `nextFollowUpDate`, or one before `quotationDate`;
   - a non-admin setting `ownerId`; any `clientId`, `status`, `number` or `lostReason` in the create/update input.
3. **AC3 (money):** amounts round-trip exactly: `"0"`, `"0.01"`, `"35000000.00"` (₹3.5 crore, above 32-bit range), `"999999999999999"` JPY. No floating-point value is used anywhere in the path: parser unit tests include values that come out wrong under `parseFloat(x) * 100`, e.g. `"1.15"` → `115n` and `"9007199254740.99"` → `900719925474099n`. `formatMoney` gives `₹1,25,000.50` and `$1,250.00`.
4. **AC4:** updating a quotation writes one `UPDATE` with the right `changedFields`. Services {A, B} → {B, C} writes one `DELETE` and one `CREATE`. Editing only the description of a quotation whose currency has since been disabled succeeds. Clearing `nextFollowUpDate` on an active quotation is rejected. On a `PO_RECEIVED` or `LOST` quotation, changing the amount is rejected and changing the description succeeds.
5. **AC5 (RBAC):**
   - A Sales user cannot read, update, change status or delete another rep's quotation (`getQuotation` returns not found), nor create one on another rep's enquiry.
   - `listQuotations` for Sales returns only their own; admins all; project managers none (pinned until M8).
   - Only admins can set or change the owner, and only to an active Sales or Admin user.
   - Each service function has happy-path, permission-denial and audit-row tests.
6. **AC6 (status machine, unit):** every pair of the four statuses is tested. Only the six allowed moves pass. `SENT`/`UNDER_NEGOTIATION` without a next follow-up date, `PO_RECEIVED` without a valid PO received date, and `LOST` without a reason are rejected. The DB `CHECK`s reject an active quotation with no `nextFollowUpDate`, `PO_RECEIVED` with no `poReceivedDate`, and `LOST` with no `lostReason`, even via raw SQL.
7. **AC7 (PO received, the "done when"):** moving an `UNDER_NEGOTIATION` quotation to `PO_RECEIVED` with a PO received date sets the status, `poReceivedDate` and `statusChangedAt` in one audited `UPDATE`, and returns a `projectDraft` whose client, services, owner, revenue (= amount, same currency) and `poReceivedDate` match. `getProjectDraft` returns the same for a `PO_RECEIVED` quotation and rejects any other status.
8. **AC8:** `updateQuotation` ignores or rejects `status`; status only changes through `changeQuotationStatus`. `PO_RECEIVED` and `LOST` quotations cannot move to any other status. **Lost:** marking a `SENT` or `UNDER_NEGOTIATION` quotation lost stores the reason and `statusChangedAt` in one audited `UPDATE`. A lost quotation no longer matches the "Follow-up due" filter, cannot move to `PO_RECEIVED`, and returns no `projectDraft`. The client timeline shows the `→ LOST` change with the reason.
9. **AC9 (follow-up sync):**
   - Logging a follow-up on an active quotation sets `lastFollowUpHighlights`, `lastFollowUpId` and `nextFollowUpDate` in the same transaction; the audit log has the `FollowUp CREATE` and a `Quotation UPDATE` under one `requestId`.
   - Logging a back-dated follow-up older than the current latest does not change the quotation.
   - Editing the latest follow-up's notes or next date re-syncs; deleting it falls back to the previous follow-up; deleting the only one leaves the fields unchanged; restoring re-syncs.
   - Logging a follow-up on an active quotation without a next date is rejected.
   - A follow-up on a `PO_RECEIVED` or `LOST` quotation updates highlights only and needs no next date.
   - Follow-ups on enquiries and clients are unaffected.
10. **AC10 (follow-up RBAC and timeline):** a Sales user can log follow-ups on their own quotations, not on another rep's (not found). `listFollowUps` includes follow-ups on quotations they can read. The client timeline shows quotation creation and status changes (`SENT → UNDER_NEGOTIATION → PO_RECEIVED`, and `→ LOST` with the reason) in order among enquiry events, only for quotations the user can read.
11. **AC11 (soft delete):** `SENT`, `UNDER_NEGOTIATION` and `LOST` quotations can be soft deleted and restored (`SOFT_DELETE` / `RESTORE`); `PO_RECEIVED` cannot. Deleted quotations drop out of lists except under "Deleted", and their follow-ups stay on the client timeline marked deleted.
12. **AC12 (list):** each filter (status, owner, client, enquiry, sector, service, currency, both date ranges, follow-up due, search by quotation number, enquiry number and client name) narrows correctly; sort and pagination work; filters combine with the RBAC scope. "Follow-up due" is computed with today in `Asia/Kolkata` (tested around midnight IST).
13. **AC13 (numbering):** numbers are sequential per year of `quotationDate` and independent of enquiry numbers; concurrent creates get distinct, gap-free numbers; a rolled-back create does not consume one; soft delete keeps the number.
14. **AC14 (concurrency):** racing `PO_RECEIVED` against delete, and `PO_RECEIVED` against `LOST`, 10 rounds each: exactly one succeeds each round, the other fails cleanly.
15. **AC15:** several quotations can be created on one enquiry, and `listQuotationsForEnquiry` returns them in scope.

**End-to-end (Playwright):**

16. **AC16:** a Sales user opens a converted enquiry, follows **Create quotation**, sees the pre-filled client, services and date, enters an amount in INR and a next follow-up date, and saves. They log a follow-up with a new next date and see the highlights and date update on the quotation. They mark it under negotiation, then **PO received**, and see the **Create project** prompt; following it shows the placeholder with the draft's client, services and revenue. On a second quotation they choose **Mark lost**, enter a reason, and see it drop out of the "Follow-up due" list.
17. **AC17:** a second Sales user does not see the quotation in their list and gets a not-found page at its URL. An admin sees it, finds it by number, and can reassign it.

**Quality:**

18. **AC18:** `pnpm typecheck && pnpm lint && pnpm test` pass, `m6_quotations` applies to an empty database after M5, and `Quotation` and `QuotationService` pass the M2 audit coverage test.

## Decisions

1. **Quotations are created only from a converted enquiry.** No standalone "New quotation" button; the enquiry is where the client, sector and services come from, and M12's funnel needs every quotation linked to one.
2. **Edited in place, no revision records** (confirmed by the product owner; settles the PLAN.md open question for M6). The M2 audit log already stores every amount and date change with before/after values, which covers "what did we quote first?". A separate revision model would mean choosing which revision is "current" in every report. A formally re-issued quotation with its own document can be a new quotation on the same enquiry (AC15); a `revision` number can be added later without breaking data.
3. **`amountMinor` is `BigInt`, not `Int`** (confirmed by the product owner). Prisma `Int` is 32-bit: the maximum is ₹2,14,74,836.47 (about ₹2.1 crore) in paise, which a single B2B quotation can exceed. Postgres `bigint` keeps integer minor units (the rule's intent) with room to spare. The same type applies to M8 revenue, M9 PO and M10 invoice amounts; CLAUDE.md rule 5 now says `BigInt`. Server actions and JSON responses serialise it as a string.
4. **Zero amounts are allowed** (e.g. a free pilot quoted for the record). Negative amounts are not.
5. **`nextFollowUpDate` and `lastFollowUpHighlights` are stored columns synced from follow-ups** (settles M5 Decision 6). Stored, because the "required while active" rule needs a column the DB can check and M11 needs a fast indexed query. Synced in the follow-up transaction through the registry hook, extended from `afterLog` to cover edit, delete and restore so the fields never point at a deleted note. Both stay editable on the quotation form; the next logged follow-up overwrites them.
6. **The client is fixed to the enquiry's client** (confirmed by the product owner). CLAUDE.md listed client as "copied from enquiry, editable" (now updated), but a quotation for a different client breaks the chain: its follow-ups, timeline and M12 funnel would split across two clients. Sector, services and owner stay editable. If a client was entered wrongly, fix it on the enquiry.
7. **Quotation numbers** follow M4 Decision 9: `QUO-<YYYY>-<NNNN>`, per calendar year of `quotationDate`, from the same `NumberSequence` table with a `QUO-<YYYY>` key.
8. **`poReceivedDate` is recorded on the move to `PO_RECEIVED`.** A schema addition beyond PLAN.md: `statusChangedAt` is when someone clicked, not when the PO arrived, and M12's quote-to-win time and M9's PO received date both need the real date. It pre-fills the project draft.
9. **`PO_RECEIVED` is terminal, and its amount is locked.** The amount becomes the project's revenue in M8; later changes belong on the project or PO. An admin correcting a mistaken `PO_RECEIVED` is out of scope for v1, as M4 Decision 5.
10. **One total amount per quotation, no line items.** PLAN.md models a single amount + currency; itemised pricing and GST lives in the quotation document (M7).
11. **Quotations can be lost** (confirmed by the product owner). PLAN.md's machine had no lost state, so a declined quotation would stay open forever, keep demanding follow-ups in M11, and inflate the open pipeline in M12. `LOST` is reachable from `SENT` or `UNDER_NEGOTIATION`, needs a `lostReason` (for M12's win/loss analysis, like M4 Decision 4), and is terminal, like an enquiry's `LOST` (M4 Decision 5). A lost quotation keeps its amount, so M12 can report quoted vs won vs lost value. Losing a quotation does not change its enquiry, which stays `CONVERTED`; other quotations on it are unaffected.

## Dependencies

None new. Reuses M3/M4/M5 table, dialog, badge, toast and timeline components, `calendarDateSchema`, `nextNumber`, and the follow-up dialog. Money parsing and formatting use the built-in `Intl` and `BigInt`; no decimal library.

## Risks

- **`BigInt` serialisation.** `JSON.stringify` throws on `BigInt`. Check the M2 audit snapshot (`audit/snapshot.ts`) stores it as a string in `before`/`after`, that server actions and React Server Components pass it safely (convert to string at the action boundary), and that TanStack Table sorts on the server, not on the client value.
- **Minor-unit exponent per currency.** Relying on `Intl` fraction digits means changing a quotation's currency between INR and JPY changes the meaning of `amountMinor`. The service always re-parses the amount string with the new currency; a currency change without an amount is rejected with a field error.
- **Sync hook ordering.** `afterChange` must see the follow-up write in the same transaction and compute "latest" with the same ordering as `getLatestFollowUp`, or the quotation shows stale highlights. AC9 covers back-dated and deleted cases.
- **`scopeFollowUps` growth.** A third polymorphic branch adds another id lookup per request. Fine at seed volumes; revisit with M8's PM scoping (M5 risk).
- **Replacing the placeholder route.** The M4 E2E test (AC14) asserts on the placeholder page; update it to assert on the real form's pre-filled values, not remove it.
- **Amount sort across currencies** is not meaningful; the UI notes it, and M12 decides conversion.

## Open questions

Settled by the product owner: edit in place with the audit log as history (Decision 2), `BigInt` money (Decision 3), client fixed to the enquiry's (Decision 6), and a `LOST` status with a reason (Decision 11).

- [ ] Should admins be able to reopen a `PO_RECEIVED` or `LOST` quotation entered by mistake (before a project exists)? Recommended: not in v1; settle before the build if it matters.

## Implementation notes (decided during the build)

- **Two schemas per quotation input.** `createQuotationFormSchema` / `updateQuotationFormSchema` validate and keep `amount` as typed; forms and server actions use them. `createQuotationSchema` / `updateQuotationSchema` add the conversion to `amountMinor`, and the service parses with those. A server action parses once and the service parses again (the `calendarDateSchema` idea), which a single transforming schema could not survive. `closedQuotationFormSchema` backs the description-and-highlights form for closed quotations.
- **`requiredDay(message)`** wraps `calendarDateSchema` for required dates (`nextFollowUpDate` on create, `poReceivedDate`), because an empty value in a union is reported as "Invalid input".
- **Sync rule for hand edits.** `syncQuotationFromFollowUps` runs only when the latest follow-up differs from `lastFollowUpId` or is the follow-up that just changed. Editing or back-dating an older follow-up therefore leaves a hand-edited highlight alone; deleting the latest one falls back to the previous one.
- **Registry hooks.** `afterLog` became `afterChange` (log, edit, delete, restore) plus `requiresNextFollowUp`, which the follow-up service checks on log and on edits that clear the next date. Only quotations implement them.
- **Closed quotations** reject any field other than `description` and `lastFollowUpHighlights` with a `DomainError`. The field is `amount` when the amount is among them, since that is the field people try to change.
- **Project managers creating a quotation** get `ForbiddenError` from the type-level `create` check, which runs before the enquiry lookup (as `createEnquiry` does).
- **Timeline.** Status changes carry `poReceivedDate` (whitelisted, like `lostReason`). Follow-up syncs write `Quotation UPDATE` rows without `status`, so they never appear as status changes.
- **Client page.** M5 shipped the client page with sidebar sections rather than tabs, so quotations are a sidebar section there (the ten latest, linking to the filtered list), not a tab.
- **Follow-up dialog.** The next-date label reads "Next follow-up (optional)" everywhere except on open quotations, where it is required.
- **Seed.** Only two sample enquiries are converted, so the five sample quotations sit on those two (AC15), covering all four statuses. A database seeded before M6 gets the quotations and their follow-ups on the next `pnpm db:seed`, and USD is enabled in settings if missing.
- **`@sales-tracker/db`** now exports the `QuotationStatus` enum.
