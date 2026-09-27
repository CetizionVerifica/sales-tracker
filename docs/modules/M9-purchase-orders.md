# M9 — Purchase orders

Depends on: M0, M1, M2, M3, M4, M5, M6, M7, M8.

## Goal

A purchase order is the client's order that authorises billing on a project. The first one usually arrives with the quotation's move to `PO_RECEIVED`. Later ones cover amendments, extensions or extra scope. The Sales owner or the project's PM records each PO on its project and attaches the client's PDF. Claude reads the amount and payment terms, and the user confirms them on the M7 review screen. Invoices (M10) are raised against a PO, and the PO's status follows them.

- CRUD on purchase orders under a project, with RBAC and audit logging through `packages/core`.
- The client's PO number, received date, amount and currency, services, and payment terms (as printed, plus optional net days).
- A **`PURCHASE_ORDER` document kind** in the M7 registry. It extracts the PO number, amount, currency and payment terms, and applies them only through `confirmExtraction` (CLAUDE.md rule 9).
- A **derived status** (`PENDING | PAID | OVERDUE`). It is stored on the row, computed by a pure function in `packages/core/status`, and written only by `recomputePurchaseOrderStatus`, which M10 calls whenever an invoice changes.
- Fills the project page's **Purchase orders** section and Documents tab that M8 left empty, and resolves M8's `TODO(M9)` on project deletion.
- Follow-ups on POs (the `PURCHASE_ORDER` target M5 reserved), PO events on the client timeline, and POs in ⌘K search.

PLAN.md "done when": status updates when invoices change. The `Invoice` model arrives in M10, so M9 ships the derivation, the recompute hook and the tests that drive it with invoice fixtures (AC4, AC5). M10's acceptance criteria prove it end to end with real invoices (see For M10).

## In scope

### Database (`packages/db`)

- **`PurchaseOrderStatus`** enum: `PENDING`, `PAID`, `OVERDUE`.
- **`PurchaseOrder`**:
  - `id`, `projectId` (FK `Project`), `clientId` (FK `Client`, copied from the project and fixed; Decision 1).
  - `poNumber String`: the client's PO number as printed, 1–64 chars, trimmed. There is no internal number sequence (Decision 2).
  - `receivedDate DateTime @db.Date`: when the PO reached us. Not in the future.
  - `amountMinor BigInt` and `currency String` (M6 Decision 3). The PO total as printed (Decision 6).
  - `paymentTerms String?`: as printed or briefly summarised, ≤ 500 chars (e.g. "50% advance, balance within 30 days of completion").
  - `paymentTermsDays Int?`: net days when the terms state them (e.g. "Net 45" → 45), 0–365 (Decision 7).
  - `description String?`: scope or notes, ≤ 2000 chars.
  - `status PurchaseOrderStatus @default(PENDING)`, `statusChangedAt DateTime?`. Written only by `recomputePurchaseOrderStatus` (Decision 4).
  - `documentId String? @unique` (FK `Document`): the PO's current document (M7 Decision 2).
  - `createdAt`, `updatedAt`, `deletedAt DateTime?` (soft-deletable).
  - Indexes: `(projectId)`, `(clientId, receivedDate)`, `(status)` (M11/M12), and a **partial unique index** on `("clientId", lower("poNumber")) WHERE "deletedAt" IS NULL` (Decision 2). Prisma cannot express it, so it goes in the migration SQL with a `@@index([clientId, poNumber])` and a comment in the schema (the M8 pattern).
- **`PurchaseOrderService`** (explicit join, as `ProjectService`):
  - `id`, `purchaseOrderId` (FK), `serviceId` (FK), `createdAt`.
  - `@@unique([purchaseOrderId, serviceId])`. Not soft-deletable; removal is a hard `DELETE`, audited with the `before` row.
- Back-relations on `Project` (`purchaseOrders`), `Client`, `Service` and `Document` (`purchaseOrder PurchaseOrder?`).
- `CHECK` constraints in the migration SQL:
  - `"amountMinor" > 0`, `"currency" ~ '^[A-Z]{3}$'`.
  - `length(btrim("poNumber")) BETWEEN 1 AND 64`.
  - `"paymentTermsDays" IS NULL OR "paymentTermsDays" BETWEEN 0 AND 365`.
- Both models are audited automatically; the M2 coverage test must pass.
- Migration: `m9_purchase_orders`.

### RBAC (`packages/core/rbac`)

The `purchaseOrder` policy rule already exists (M1): Sales have CRUD where `pipelineOwnerId` is theirs, PMs have CRUD where `projectManagerId` is theirs, and admins have everything. **No change to `policy.ts`.** M9 adds what feeds it:

- **`purchaseOrderResource(row)`** builds `{ type: 'purchaseOrder', projectManagerId: project.managerId, pipelineOwnerId: project.quotation.ownerId }`, read through relations and never copied onto the PO (M8 Decision 4, M8 "For M9"). Reassigning the project's manager or the quotation's owner moves PO access with it. One `purchaseOrderAccessSelect` builds the select for every loader.
- **`scopePurchaseOrders(user)`**:
  - `ADMIN`: `{}`.
  - `SALES`: `{ project: { quotation: { ownerId: user.id } } }`.
  - `PROJECT_MANAGER`: `{ project: { managerId: user.id } }`.
  - This matches `scopeProjects`, so anyone who can read a project can read its POs.
- Creating a PO needs `read` on the project (`projectResource`), then `assertCan(ctx, 'create', purchaseOrderResource(...))` built from that project. For an unassigned project, only the Sales owner and admins qualify.
- Documents and follow-ups on POs inherit these permissions through the M7 and M5 registries. A user can view a PO document if they can read the PO, and can upload, re-run or confirm one if they can update the PO.

### Status (`packages/core/status/purchase-order.ts`)

- Pure functions, no database access. Exported from `packages/core/status/index.ts`.
- **`derivePurchaseOrderStatus(po, invoices)`**, where `po` is `{ amountMinor, currency }` and `invoices` are the PO's **live** invoices as `{ status: 'PENDING' | 'PAID' | 'OVERDUE', amountMinor }[]`:
  1. Any invoice `OVERDUE` → `OVERDUE`, even if others are paid.
  2. At least one invoice, every invoice `PAID`, **and** the invoiced total ≥ the PO amount → `PAID` (Decision 5).
  3. Otherwise, including a PO with no invoices, → `PENDING`.
- It assumes invoices are in the PO's currency, which M10 enforces.
- No `canTransition`/`assert` functions. Nobody chooses a PO's status, so there is no move to validate.

### Schemas (`packages/core/schemas/purchase-order.ts`)

- Reuses M6's `moneySchema`, `formatMoney` and `toAmountString`, and M4's `calendarDateSchema` / M6's `requiredDay`.
- As in M6 and M8, **form** schemas that keep `amount` as typed (`createPurchaseOrderFormSchema`, `updatePurchaseOrderFormSchema`), and service schemas that convert it to `amountMinor` (`createPurchaseOrderSchema`, `updatePurchaseOrderSchema`).
- `poNumber`: trimmed, internal whitespace collapsed to single spaces, 1–64 chars. Stored as typed. Compared case-insensitively.
- `createPurchaseOrderSchema`: `projectId`, `poNumber`, `receivedDate`, `amount` (> 0), `currency`, `serviceIds` (1–10 unique), `paymentTerms?`, `paymentTermsDays?` (integer 0–365), `description?`. **No `clientId`, `status`, `statusChangedAt` or `documentId`.**
- `updatePurchaseOrderSchema`: `poNumber`, `receivedDate`, `amount`, `currency`, `serviceIds`, `paymentTerms`, `paymentTermsDays`, `description`, all optional. **No `projectId`** (a PO does not move between projects), and no `clientId`, `status` or `documentId`. An empty string clears optional fields and `undefined` leaves them unchanged (M3 convention).
- `listPurchaseOrdersSchema`: `listParamsSchema` plus:
  - Filters: `status[]`, `projectId`, `clientId`, `serviceId`, `managerId` (the project's manager, or `'none'`), `ownerId` (the pipeline owner; admins only), `currency[]`, `receivedFrom/To`, `document` (`none | reading | toReview | reviewed | failed`), `recordStatus`.
  - Search: `q` searches PO number, project number and name, client name and payment terms.
  - Sort: `receivedDate` (default, desc), `poNumber`, `client`, `project`, `amount` (mixed currencies sort by minor units, noted in the UI, as M6), `status`, `createdAt`, `updatedAt`.
- Action-input shapes (`withId(...)`, `idOnlySchema`) live in core.
- **`searchRecordsSchema`**: `SearchResultType` gains `purchaseOrder`.

### Extraction (`packages/core/extraction`, `schemas/extraction.ts`, `schemas/document.ts`)

- **`PURCHASE_ORDER_EXTRACTION_FIELDS`**:
  - `poNumber` (text ≤ 64): the purchase order number as printed, not our quotation reference.
  - `documentDate` (date): the date printed on the PO.
  - `clientName` (text ≤ 200): the company issuing the PO.
  - `amount` (amount): the PO total, including taxes if the document shows a total with them (the M7 rule).
  - `currency` (currency).
  - `paymentTerms` (text ≤ 500): the payment terms as printed, summarised if long.
  - `paymentTermsDays` (integer 0–365): the net days only when the terms state a single number of days. Otherwise null.
- `normaliseExtraction` gains an **`integer`** format with `min`/`max`: digits only, in range, otherwise null with low confidence.
- **Registry entry** (`extraction/kinds.ts`, `PURCHASE_ORDER`):
  - `parentModel: 'PurchaseOrder'`. `load` returns the PO number and client as the label, `purchaseOrderResource`, and current values.
  - Review rows:
    - `poNumber → poNumber`.
    - `amount + currency → amount, currency` (one row; both or neither).
    - `paymentTerms → paymentTerms`.
    - `paymentTermsDays → paymentTermsDays`.
  - Info only: `documentDate` ("Date on the PO"; not stored, Decision 12) and `clientName` (drives the M7 client mismatch warning against the PO's client).
  - `locked`: none in M9. M10 may lock the amount once invoices exist (see For M10).
  - `setDocument`: the conditional update on `documentId` (M7 implementation notes).
  - `currentWhere: { purchaseOrder: { isNot: null } }`.
  - `applyConfirmed`: calls `updatePurchaseOrder`.
  - `visibleIds` and `labels`: through the `PURCHASE_ORDER` follow-up target.
- `REVIEW_RECORD_SCHEMAS.PURCHASE_ORDER = updatePurchaseOrderFormSchema`.
- `uploadDocument` now accepts `kind = PURCHASE_ORDER`. `INVOICE` is still rejected until M10.
- A duplicate PO number applied on confirm fails the whole confirm with the `poNumber` field error. Nothing is written (M7 AC6 semantics).

### Services (`packages/core/services/purchase-order.service.ts`)

Each function takes `ctx`, validates with the schema, calls `assertCan`, and writes inside `withTx`. Update and delete writes are conditional `updateMany` calls that re-check the `deletedAt` (and, for deletes, `documentId`) that were read (the M4/M5 race fix). A request that loses the race fails with "Someone else changed this purchase order". Unique-index violations go through `guardUnique`.

- `listPurchaseOrders(ctx, input)`: `assertCan(ctx, 'list', 'purchaseOrder')`, then `scopePurchaseOrders` ANDed with filters. Returns `Page<PurchaseOrderRow>` with client, project number and name, manager, pipeline owner, service names, formatted amount, and document state.
- `getPurchaseOrder(ctx, id)`: not visible → `NotFoundError` (M4 Decision 7).
  - Includes the project (number, name, status, revenue, currency), its quotation and enquiry numbers and ids (for the pipeline strip), services, and the current document summary.
  - Includes the PO totals on the project (below).
  - Includes the permissions the page needs: `canUpdate`, `canDelete` (with a reason when not).
- `getPurchaseOrderDraft(ctx, projectId)`: the create form's defaults.
  - Client and services from the project, and the project's currency.
  - `amount` = project revenue minus the live POs' total in the project currency. Left blank when that is zero or less, or when the project has POs in other currencies.
  - `receivedDate` = the quotation's `poReceivedDate` when the project has no live PO yet, otherwise today (IST) (Decision 12).
  - Rejects a cancelled project.
- `createPurchaseOrder(ctx, input)`:
  - The project must be live and readable; otherwise `NotFoundError`. A `CANCELLED` project gets a `DomainError` on `projectId`: "A cancelled project takes no new purchase orders" (Decision 11). `NOT_STARTED`, `IN_PROGRESS`, `ON_HOLD` and `COMPLETED` projects are accepted.
  - Takes a transaction-scoped lock on the project (`pg_advisory_xact_lock` keyed on the project id, as `user.service.ts` does; a read, not a write). This stops the create racing `softDeleteProject` or a cancel (AC12).
  - `clientId` is copied from the project.
  - `poNumber` must not match a live PO of the same client (case-insensitive): `DomainError` "This client already has PO <number> (on PRJ-…)". The partial unique index backs this for concurrent creates.
  - Every `serviceId` must be one of the project's services (Decision 8). No active check, since they were checked on the project. `currency` must be enabled when it differs from the project's.
  - Creates the `PurchaseOrder` row (`PENDING`, `statusChangedAt = now`), then one `PurchaseOrderService` row per service, as separate writes (M2 rejects nested writes).
  - Returns the PO and a `coverage` result. When the live POs in the project currency now exceed the project revenue, it includes a non-blocking warning (Decision 6).
- `updatePurchaseOrder(ctx, id, input)`:
  - `update` permission (admins, the pipeline owner, the project's PM).
  - `poNumber` uniqueness, services within the project's and currency re-checked only when they **change**. Services diffed as in M4.
  - When `amount` or `currency` changes, calls `recomputePurchaseOrderStatus` in the same transaction.
  - `status` in the input is rejected as an unknown key (strict schema).
- `softDeletePurchaseOrder` / `restorePurchaseOrder`: `delete` permission (M1 policy: admins, the pipeline owner and the project's PM; Decision 10).
  - Soft delete keeps the document attached, since the M7 soft-delete rules apply to the PO's document only when it is deleted itself.
  - Restoring needs a live project and no other live PO of the client with the same number.
  - M10 adds "not while it has live invoices".
- `listPurchaseOrdersForProject(ctx, projectId)` and `listPurchaseOrdersForClient(ctx, clientId)`: for the project and client pages; both apply `scopePurchaseOrders`.
- **`recomputePurchaseOrderStatus(tx, poId, loadInvoices = liveInvoicesFor)`**: not exported from the package index; only core services call it.
  - Reads the PO and its live invoices through `loadInvoices`, derives the status, and writes `status` and `statusChangedAt` with a guarded `updateMany`, only when the status changes. The write runs in the caller's transaction, so its audit row carries the caller's `source` and `requestId` (`system` for M10's nightly job).
  - In M9, `liveInvoicesFor` returns `[]`. M10 replaces its body with the `Invoice` query. Tests pass their own loader to drive the derivation against a real PO row (AC5).
  - This is the **only** code that writes `PurchaseOrder.status` (Decision 4). A grep-style test pins it, as M7 AC4 does for `fieldMap`.

**Project side** (`project.service.ts`):

- `softDeleteProject` refuses while the project has live POs: `DomainError` "Delete this project's purchase orders first (N)". It takes the same project lock as `createPurchaseOrder`. This resolves the `TODO(M9)`.
- `changeProjectStatus` to `CANCELLED` takes the same lock, so a PO cannot be created on a project mid-cancel.
- `updateProject` rejects removing a service that a live PO on the project still uses: a field error on `serviceIds` naming the PO(s).
- `getProject` returns:
  - `purchaseOrders`: the live POs with number, received date, amount, status and document state.
  - `poTotals`: per currency, plus `covered` / `revenue` in the project currency and `overCovered: boolean`.
  - `canDelete` is false with the reason "Has purchase orders" while any live PO exists.
- `getQuotation` and `getEnquiry` gain what the pipeline strip needs: whether a live PO exists under them, and its id when there is exactly one.

**Follow-up target** (`follow-up-targets.ts`): add a `PURCHASE_ORDER` entry.

- `auditModel: 'PurchaseOrder'`.
- `load`: label = `PO <poNumber>`, resource = `purchaseOrderResource`.
- `visibleIds` (through `scopePurchaseOrders`), `labels`, `pickable`.
- No `afterChange` or `requiresNextFollowUp`: POs keep no follow-up fields.
- `scopeFollowUps` gains the `PURCHASE_ORDER` branch.

**Timeline** (`timeline.service.ts`):

- PO `CREATED`, `DELETED` and `RESTORED` events through the registry.
- `STATUS_CHANGE` (`PENDING → PAID` etc.). These rows only appear from M10 on, but the mapping and a test with a seeded audit row ship now.
- Amount, terms and number changes are not timeline events; they are on the record's Audit tab.
- PO documents appear through the M7 `DOCUMENT` kind.

**Search** (`search.service.ts`): POs by PO number, scoped by `scopePurchaseOrders`. The detail line is the client name and project number.

**Summary** (`summary.service.ts`): `purchaseOrderStatusCounts(ctx)` returns `PENDING`, `PAID` and `OVERDUE` counts, plus `toReview` (current PO documents with extraction `SUCCEEDED` and review `PENDING`), all scoped like the list.

### Seed

- Development only:
  - One PO on most seeded projects, as the Sales owner, dated from the quotation's `poReceivedDate` and for the quotation amount.
  - One project with **two** POs (a main PO and an extra-scope PO whose amount takes the project over revenue, so the warning shows).
  - One PO with text-only terms ("50% advance, balance on completion") and one with `paymentTermsDays = 45`.
  - At least one live, non-cancelled project **without** a PO, so the create flow can be tried by hand.
  - The cancelled project gets none.
- One follow-up logged on a PO by the PM.
- All POs are `PENDING`, since there are no invoices until M10.
- Written through the services in the same all-or-nothing seed transaction, `source: 'system'`. Added when no POs exist, even if projects do (the M5/M6/M8 pattern).
- No documents are seeded (M7). `seed:documents` gains a sample PO PDF (`test/fixtures/documents/globex-po.pdf`) attached to one seeded PO.

### Web (`apps/web`)

Follows `docs/UI-GUIDE.md` (templates 4.1–4.3 and 4.5, `--stage-po`, the PO status badges) and its checklist.

- **Nav:** **Purchase orders** in the pipeline group after Projects, with `stage: 'po'`, shown when `can(user, 'list', 'purchaseOrder')`. **+ New → PO** opens `/purchase-orders/new` (Sales, PMs and admins).
- **`/purchase-orders`** (list, template 4.1):
  - Summary strip: Pending, Overdue, Paid, To review (clickable filter chips). Overdue uses the attention style, per the guide.
  - Columns:
    - PO number (links to detail), client, project (number and name).
    - Received date, amount (`<Money>`), payment terms (truncated, full text on hover), status badge.
    - Document state (icon plus text: none, reading, to review, reviewed, could not read), updated.
  - Filters:
    - Status, project, client, service, currency, received range, document state, search.
    - Manager (admins and Sales, including "Unassigned"), owner (admins only).
    - "Deleted" view with Restore (for users who can delete).
  - **New PO** button for users who can create.
- **`/purchase-orders/new?projectId=…`** (full page at max 880px, as the UI guide's form template says for POs):
  - Without `projectId`, the first field is a project combobox. It lists live, non-cancelled projects the user can read, searchable by number, name and client. Choosing one loads the draft.
  - Pre-filled from `getPurchaseOrderDraft`:
    - Client (read-only, "From PRJ-…").
    - Services (checkboxes limited to the project's, all ticked).
    - Amount and currency ("Remaining on PRJ-…").
    - Received date ("From QUO-…'s PO received date" on the first PO).
  - Fields in sections: **Purchase order** (PO number, received date, amount + currency, services), **Payment terms** (terms text, net days), **Notes** (description), **Document** (an optional drop zone: PDF, PNG, JPEG, WebP; up to 20 MB).
  - A warning Alert under the amount when the POs would exceed the project revenue, with both totals. It warns but does not block (Decision 6).
  - On submit: the server action creates the PO, then the page uploads the file to `POST /api/documents` with `kind = PURCHASE_ORDER` and the new id, then goes to the PO. If the upload fails, the PO is kept, the page still goes to the PO, and an error toast asks the user to upload again from the Document card (Decision 3).
  - React Hook Form + `zodResolver` with the core form schema; server action via M1's `action()`.
  - Footer: `[Cancel]` `[Create purchase order]`.
- **`/purchase-orders/[id]/edit`**: the same page. The project is read-only and there is no Document section (the card on the detail page handles replacement).
- **`/purchase-orders/[id]`** (detail, template 4.2):
  - Breadcrumb `Purchase orders / <poNumber>`. Header: `PO <poNumber>` with `<client> — <project name>` beneath, status badge, `[Log follow-up]` `[Edit]` `[⋯]`.
  - No status actions. A muted line by the badge says "Status follows this PO's invoices" (Decision 4).
  - Pipeline strip: Enquiry, Quotation and Project filled and linked, PO current, Invoice hollow.
  - Tabs: Overview | Timeline | Documents | Audit.
  - Overview:
    - PO details in a two-column field grid (PO number, received date, amount, services, payment terms, net days, description).
    - The M7 **Document** card with kind `PURCHASE_ORDER` ("Upload PO document"; reading / ready to review / could not read / reviewed states).
    - An **Invoices** section with the empty state "Invoices arrive in a later release" (M10 replaces it).
  - Side panel: client, project (link and status badge), manager, pipeline owner, amount, received date, payment terms, and "POs on this project" (total vs project revenue, with the over-revenue warning).
  - `⋯`: **Delete** (confirmation names the PO: "Delete PO 4500012345?").
- **`/documents/[id]/review`**: works through the registry; check the `PURCHASE_ORDER` labels and back-link already in `review/page.tsx`. The client mismatch warning compares against the PO's client.
- **`/projects/[id]`**:
  - The **Purchase orders** section replaces M8's empty state. It shows a compact table (PO number, received, amount, terms, status, document state), a totals line per currency, and a coverage line: "POs cover ₹10,00,000 of ₹10,00,000 revenue", with a warning style when over.
  - `[Add PO]` links to `/purchase-orders/new?projectId=…`. It is hidden when the user cannot create or the project is cancelled.
  - The Documents tab lists the current documents of the project's live POs, replacing the placeholder.
  - The pipeline strip links the PO stage: to the PO when there is exactly one, otherwise to the section (`#purchase-orders`).
  - `⋯ → Delete` explains "Delete its purchase orders first" when blocked.
- **`/quotations/[id]`** and **`/enquiries/[id]`**: the pipeline strip fills and links the PO stage as above.
- **`/clients/[id]`**:
  - A **Purchase orders** sidebar section (the latest ten, linking to the filtered list).
  - The timeline record filter includes POs (`?record=PURCHASE_ORDER:<id>`).
  - The Documents tab includes PO documents.
- `apps/web/lib/follow-up-labels.ts`: add `recordHref` for POs. ⌘K shows PO results.
- `StatusBadge` gains the `purchaseOrder` entity with the guide's styles: Pending (neutral), Paid (success), Overdue (attention).

## Out of scope

- The `Invoice` model, marking anything paid, and the nightly overdue job: M10. Until then every PO is `PENDING`.
- Partial payments (PLAN.md open question, M10).
- Creating a PO **from** a document before its number is typed (upload-first); see Decision 3.
- PO line items, tax breakdown, validity or expiry dates, and PO acknowledgements sent back to the client.
- POs without a project, a PO spanning several projects, or moving a PO to another project.
- Amendments as separate records: an amended PO is edited in place with its document replaced (Decision 9).
- Currency conversion of PO totals and PO/receivables dashboards: M12. My Today items: M11.
- MCP tools and bulk import of POs: M13.

## Acceptance criteria

**Service and data** (integration tests against the test database, with `memoryFileStore` and `mockExtractor`):

1. **AC1 (create):** a Sales user creates a PO on the project of their quotation. The PO is `PENDING`, has the project's client, the chosen services, amount, currency and received date. The audit log has one `PurchaseOrder CREATE` and one `PurchaseOrderService CREATE` per service, with `source: 'web'` under one `requestId`.
2. **AC2 (validation):** rejected with field errors:
   - an empty or 65-char PO number;
   - a PO number matching a live PO of the same client ignoring case and surrounding spaces. The same number is accepted for a different client, and for the same client after the earlier PO is soft deleted;
   - a future `receivedDate`;
   - an amount of 0, a negative amount, or too many decimals; a disabled currency that differs from the project's;
   - no services, duplicates, or a service not on the project;
   - `paymentTermsDays` of -1, 366 or 1.5;
   - a cancelled, soft-deleted or unreadable project;
   - any `clientId`, `status` or `documentId` in create/update input, and `projectId` in update input.
3. **AC3 (RBAC):**
   - `listPurchaseOrders` returns, for a PM, only POs on projects they manage; for Sales, only POs under quotations they own; for admins, all.
   - Another PM, and another Sales rep, get not found for the PO and for its document.
   - The project's PM and the pipeline owner can create, update, soft delete and restore. On an unassigned project, only the Sales owner and admins can.
   - Reassigning the project to another PM, or the quotation to another rep, moves the PO between their lists.
   - Each service function has happy-path, permission-denial and audit-row tests.
4. **AC4 (derivation, unit):** `derivePurchaseOrderStatus` returns:
   - `PENDING` with no invoices, with all `PENDING`, and with a mix of `PAID` and `PENDING`;
   - `OVERDUE` when any invoice is `OVERDUE`, including alongside `PAID` ones;
   - `PAID` when all are `PAID` and the total equals or exceeds the PO amount;
   - `PENDING` when all are `PAID` but the total is below the PO amount (Decision 5).
5. **AC5 (recompute, the "done when" as far as M9 can go):**
   - `recomputePurchaseOrderStatus` with a fixture loader writes one audited `UPDATE` (`status`, `statusChangedAt`) with the caller's `source` and `requestId` when the derived status changes, and writes nothing when it does not.
   - With `source: 'system'` the audit row says `system`.
   - A status forced by raw SQL is corrected on the next recompute.
   - Changing a PO's amount recomputes in the same transaction.
   - A grep-style test asserts nothing in `packages/core` other than `recomputePurchaseOrderStatus` writes `status` on `purchaseOrder`.
6. **AC6 (document and extraction):**
   - The PM uploads a PDF to a PO. A `PURCHASE_ORDER` document is created, the PO's `documentId` points to it, and the job runs with the fixture. The PO is unchanged until confirm.
   - Confirming `poNumber`, `amount = "12,50,000"` + `INR`, `paymentTerms` and `paymentTermsDays = "45"` updates the PO through `updatePurchaseOrder` and marks the document `CONFIRMED` with those `appliedFields`, under one `requestId`.
   - Confirming a PO number that another live PO of the client already has fails with the field error, and neither record changes.
   - A client-name mismatch shows the warning. `INVOICE` uploads are still rejected.
   - The normaliser keeps `"45"`, and nulls `"45 days"`, `"400"` and `"-5"` with low confidence.
7. **AC7 (project interplay):**
   - `softDeleteProject` is refused while the project has a live PO, and allowed once its POs are deleted.
   - A cancelled project rejects new POs but its existing POs stay readable and editable.
   - `updateProject` removing a service used by a live PO is rejected with a field error.
   - `getPurchaseOrderDraft`:
     - On a project with no POs, it returns the quotation's `poReceivedDate` and the full revenue.
     - After a PO for part of it, it returns today and the remainder.
     - After POs in another currency, it leaves the amount blank.
   - `getProject` returns the POs, per-currency totals and `overCovered` when the POs exceed revenue.
8. **AC8 (follow-ups and timeline):**
   - The PM logs a follow-up on a PO. It appears on the client timeline for the PM, the Sales owner and admins, and not for another PM.
   - The client timeline shows PO creation, deletion and restore, and a seeded `PENDING → PAID` audit row as a status change, in date order among project events, only to users who can read the PO.
9. **AC9 (soft delete):**
   - Soft delete and restore write `SOFT_DELETE` / `RESTORE`. A deleted PO drops out of lists, the project section and search, except under "Deleted".
   - Restoring is rejected when the client now has another live PO with the same number, or when the project is deleted.
10. **AC10 (list):**
    - Each filter narrows correctly: status, project, client, service, manager including unassigned, owner, currency, received range, document state, and search by PO number, project number and name, client name and terms.
    - Sort and pagination work, and filters combine with the RBAC scope.
    - `purchaseOrderStatusCounts` matches the filtered list for each chip.
11. **AC11 (search):** ⌘K finds a PO by its number for users who can read it, and not for others.
12. **AC12 (concurrency, 10 rounds each):**
    - Two creates racing with the same client and PO number: exactly one succeeds, and the other gets the duplicate error.
    - A PO create racing `softDeleteProject`: never a live PO on a deleted project.
    - A PO create racing **Cancel project**: never a PO created after the cancel committed.
    - Two confirms of different documents setting the same PO number on two POs: exactly one succeeds.
13. **AC13 (seed):** `pnpm db:seed` on an M8 database adds the sample POs once, including a two-PO project over revenue and a live project with none.

**End-to-end (Playwright, `memoryFileStore`/local store + `mockExtractor`):**

14. **AC14:**
    - A Sales user opens a project and clicks **Add PO**. They see the client, services, amount and received date pre-filled.
    - They type the PO number, attach the sample PO PDF, and create it.
    - The PO page shows "Reading document…" and then "Ready to review". The review screen shows the extracted payment terms and amount next to the current values.
    - The user corrects the net days and confirms. The PO shows the payment terms.
    - The project's Purchase orders section lists the PO as Pending, and the pipeline strip's PO stage links to it.
15. **AC15:**
    - The project's PM sees the PO and edits its description.
    - A second PM gets a not-found page at the PO URL and at its document's review URL.
    - An admin's **Delete** on the project explains that its purchase orders must be deleted first.

**Quality:**

16. **AC16:** `pnpm typecheck && pnpm lint && pnpm test` pass. `m9_purchase_orders` applies to an empty database after M8. `PurchaseOrder` and `PurchaseOrderService` pass the M2 audit coverage test. A test asserts the partial unique index exists. The UI guide checklist is run on every new screen.

## Decisions

1. **A PO belongs to one project, and a project can have many POs** (PLAN.md). POs are recorded only on a live, non-cancelled project. The client is fixed to the project's, which is fixed to the quotation's (M6 Decision 6, M8 Decision 3).
2. **The PO number is the client's, and there is no internal sequence** (UI guide §5: "PO uses the client's PO number"). It is unique per client among live POs, compared case-insensitively. A partial unique index enforces it, so a deleted PO does not block re-entry and two clients can both use "PO-001".
3. **Record first, document second.** M7 left upload-first to M9. The PO is created from a short form pre-filled from the project, and its document attaches to it. Extraction then proposes values through the unchanged M7 review screen. Upload-first would need three things this approach avoids: a parentless document state in M7's registry, a draft PO with no amount (which breaks M10 and M12 sums), and a second review UI. The pre-fill covers the common case of one PO for the whole quoted amount, and the user types only the PO number. Revisit if users find that tedious.
4. **Status is stored and derived, never set.** It is stored so lists can filter and sort by it and M11/M12 can query it without joining invoices. It is written only by `recomputePurchaseOrderStatus`, which calls the pure `derivePurchaseOrderStatus` (CLAUDE.md rule 8). A PO with no invoices is `PENDING`. Read literally, "all invoices paid" would make it `PAID`.
5. **`PAID` also requires the PO to be fully invoiced** (confirmed by the product owner). Without this, a ₹10L PO with one paid ₹5L advance invoice would show Paid while ₹5L is still to bill. This refines CLAUDE.md's PurchaseOrder rule, and CLAUDE.md and PLAN.md now say so, as M6 Decision 3 did for rule 5.
6. **The amount is the PO total as printed**, including taxes when the PO shows a total with them (the M7 extraction rule), and must be greater than zero. If POs exceed the project revenue, that is a **warning, not an error**: the quotation may exclude GST and the PO include it, and variations are common. M12 decides how to report pre-tax values.
7. **Payment terms are free text plus optional net days.** Real terms vary ("50% advance, balance on completion"), so the text is what the client wrote. `paymentTermsDays` is the number M10 needs for invoice due dates: M10 defaults an invoice's due date from its PO's net days, falling back to `CompanySettings.defaultInvoiceDueDays` when the PO has none (confirmed by the product owner; CLAUDE.md's due-date line now says so).
8. **A PO's services must be among its project's.** This keeps M12's service reports consistent. Extra scope in a new service means an admin adds it to the project first (M8 Decision 6). For the same reason, a project cannot drop a service a live PO uses.
9. **Edited in place.** An amended PO (same number, new revision) updates the record and replaces its document. The audit log and the replaced, soft-deleted document are the history (M6 Decision 2, M7 Decision 2).
10. **Permissions follow the M1 policy unchanged:** the pipeline owner and the project's PM both have CRUD, admins everything. Unlike projects, deleting a PO is not admin-only, because mistyped POs are common and both roles enter them. M10 blocks deleting a PO that has invoices.
11. **A project with live POs cannot be deleted, and a cancelled project takes no new POs.** Existing POs on a cancelled project stay, since work done before cancellation may still be billed (M10 decides whether invoices are allowed there).
12. **`receivedDate` defaults to the quotation's `poReceivedDate` for a project's first PO** (M6 Decision 8, M8 "For M9"), and to today for later ones. The date printed on the PO is shown on the review screen for information only. It is not stored, because it is not the received date (the same distinction as M6 Decision 8).

## For M10 (invoices)

- Call `recomputePurchaseOrderStatus(tx, poId)` in the **same transaction** on every invoice create, amount change, status change (including the nightly overdue job, `source: 'system'`), soft delete and restore. Replace the body of `liveInvoicesFor` with the `Invoice` query. M10's "done when" test should assert the PO status after each of these.
- Invoices must be in their PO's currency, because `derivePurchaseOrderStatus` sums amounts.
- `softDeletePurchaseOrder` must gain "not while it has live invoices", using the same lock pattern on the PO row that M9 uses on the project. Consider refusing a PO amount below its invoiced total, and adding that as a `locked` rule in the PO document kind.
- Default the invoice due date to `invoiceDate` plus the PO's `paymentTermsDays`, falling back to `CompanySettings.defaultInvoiceDueDays` when the PO has none, still overridable per invoice (Decision 7). The form should say which one it used ("Net 45 from PO 4500012345" or "Company default, 30 days").
- The invoice client mismatch warning compares against the PO's client.
- The PO page's **Invoices** section and the pipeline strip's Invoice stage are the places M10 fills in.

## Dependencies

None new. Reuses M3–M8 components (DataTable, FilterBar, SummaryStrip, StatusBadge, PipelineStrip, Money, Timeline, FollowUpSheet, the M7 Document card and review screen), `moneySchema`, `calendarDateSchema`, `requiredDay`, `guardUnique` and the M7 upload route.

## Risks

- **Stored status can drift.** Any invoice write that skips `recomputePurchaseOrderStatus` leaves a stale PO status. Mitigations: one helper, the grep test (AC5), and M10 recomputing inside every invoice write. M10's nightly job can also recompute POs with overdue invoices as a safety net.
- **The "done when" is only half testable in M9.** Without invoices, the recompute is proven with a fixture loader. The loader is a parameter only for tests, so a reviewer should check that no production caller passes one.
- **Partial unique index on an expression.** Prisma does not model `lower("poNumber")`, and a later `prisma migrate dev` may try to drop it. Keep the schema comment and the existence test (AC16), as M8 did.
- **Lock ordering.** `createPurchaseOrder`, `softDeleteProject` and the cancel move all take the project lock first. M10 must take the PO lock after the project lock, never before, to avoid deadlocks.
- **Over-coverage noise.** If quotations are usually pre-tax and POs post-tax, the warning will show on most projects and be ignored. Watch it on real data. M12's tax decision may change the comparison.
- **Two requests on create.** The PO is saved before the file uploads, so a failed upload leaves a PO without a document. This is acceptable (the card offers upload), but the E2E should cover the error toast.
- **Scope depth.** `scopePurchaseOrders` joins through the project (and, for Sales, the quotation). Measure `listFollowUps`, `listDocuments` and the client timeline on the seed after adding the `PURCHASE_ORDER` branches (M5/M8 risk).

## Open questions

Settled by the product owner: a PO is `PAID` only when fully invoiced and every invoice is paid (Decision 5); M10 defaults invoice due dates from the PO's net days before the company default (Decision 7). CLAUDE.md and PLAN.md are updated to match.

None open.
