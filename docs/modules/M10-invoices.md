# M10 — Invoices

Depends on: M0, M1, M2, M3, M4, M5, M6, M7, M8, M9.

## Goal

An invoice is what we bill the client against one of their purchase orders. It is raised in the accounting system and recorded here with its PDF, so the pipeline can track what has been billed, what has been paid, and what is late. The Sales owner or the project's PM records each invoice on its PO. Claude reads the invoice number, date, amount and due date, and the user confirms them on the M7 review screen. A nightly job marks unpaid invoices past their due date `OVERDUE`, and every invoice change recomputes its PO's derived status (M9).

- CRUD on invoices under a purchase order, with RBAC and audit logging through `packages/core`.
- Our invoice number, invoice date, one service, amount (in the PO's currency), due date, payment date and reference.
- **Due date defaulting:** `invoiceDate` + the PO's `paymentTermsDays`, falling back to `CompanySettings.defaultInvoiceDueDays`, overridable per invoice (M9 Decision 7).
- An **invoice status machine** (`PENDING → PAID`, `PENDING → OVERDUE → PAID`) in `packages/core/status/invoice.ts`, with **Mark paid** as the only user-chosen move.
- A **nightly overdue job** in `apps/worker`, `source: 'system'`.
- An **`INVOICE` document kind** in the M7 registry, with a **client mismatch warning** against the PO's client (name and, when both are known, GSTIN; M3 Decision 9).
- Wires invoices into `recomputePurchaseOrderStatus`, and resolves M9's handoff: no PO delete while it has live invoices, and the PO page's **Invoices** section.
- Follow-ups on invoices (the `INVOICE` target M5 reserved, mostly payment chasing), invoice events on the client timeline, invoices in ⌘K search, and the Invoice stage of the pipeline strip.
- The full-pipeline Playwright flow CLAUDE.md asks for (enquiry → quotation → project → PO → invoice).

PLAN.md "done when": past-due unpaid invoices become `OVERDUE`. AC5 proves it through the job, and AC6 proves the PO status follows every invoice write (M9's "done when", end to end).

## In scope

### Database (`packages/db`)

- **`InvoiceStatus`** enum: `PENDING`, `PAID`, `OVERDUE`.
- **`DueDateBasis`** enum: `PO_TERMS`, `COMPANY_DEFAULT`, `MANUAL` (Decision 6).
- **`Invoice`**:
  - `id`, `purchaseOrderId` (FK `PurchaseOrder`), `clientId` (FK `Client`, copied from the PO and fixed; Decision 1).
  - `invoiceNumber String`: our invoice number as issued by the accounting system, 1–64 chars, trimmed. Unique among live invoices, case-insensitive, company-wide (Decision 2).
  - `invoiceDate DateTime @db.Date`: the date on the invoice. Not in the future.
  - `serviceId String` (FK `Service`): one of the PO's services (Decision 4).
  - `amountMinor BigInt` and `currency String`: the invoice total as printed, including taxes (the M7 rule). `currency` is copied from the PO and fixed (Decision 3).
  - `dueDate DateTime @db.Date`, `dueDateBasis DueDateBasis`.
  - `status InvoiceStatus @default(PENDING)`, `statusChangedAt DateTime?`. Changed only through `packages/core/status/invoice.ts`.
  - `paidAt DateTime? @db.Date`: the day the payment was received (a calendar date, as CLAUDE.md names it). `paymentReference String?` (UTR, cheque number; ≤ 200 chars).
  - `unmarkedPaidReason String?` (≤ 500 chars): why an admin last reversed a payment (Decision 8).
  - `description String?` (≤ 2000 chars).
  - `documentId String? @unique` (FK `Document`; M7 Decision 2).
  - `createdAt`, `updatedAt`, `deletedAt DateTime?` (soft-deletable).
  - Indexes: `(purchaseOrderId)`, `(clientId, invoiceDate)`, `(status, dueDate)` (the nightly job, M11, M12), `(serviceId)`, and a **partial unique index** `invoice_live_number_key` on `(lower("invoiceNumber")) WHERE "deletedAt" IS NULL`. SQL only, with a `@@index([invoiceNumber])` and a schema comment (the M8/M9 pattern).
- Back-relations on `PurchaseOrder` (`invoices`), `Client`, `Service` and `Document` (`invoice Invoice?`).
- `CHECK` constraints in the migration SQL:
  - `"amountMinor" > 0`, `"currency" ~ '^[A-Z]{3}$'`, `length(btrim("invoiceNumber")) BETWEEN 1 AND 64`.
  - `"dueDate" >= "invoiceDate"`.
  - `("status" = 'PAID') = ("paidAt" IS NOT NULL)`, and `"paidAt" IS NULL OR "paidAt" >= "invoiceDate"`.
- `Invoice` is audited automatically; the M2 coverage test must pass.
- Migration: `m10_invoices`.

### RBAC (`packages/core/rbac`)

The `invoice` policy rule already exists (M1) and matches `purchaseOrder`. **No change to `policy.ts`** (Decision 14).

- **`invoiceResource(row)`** builds `{ type: 'invoice', projectManagerId: po.project.managerId, pipelineOwnerId: po.project.quotation.ownerId }`, read through relations (M8 Decision 4). One `invoiceAccessSelect` for every loader.
- **`scopeInvoices(user)`**: `ADMIN` `{}`; `SALES` `{ purchaseOrder: { project: { quotation: { ownerId } } } }`; `PROJECT_MANAGER` `{ purchaseOrder: { project: { managerId } } }`. Anyone who can read a PO can read its invoices.
- Creating an invoice needs `read` on the PO, then `assertCan(ctx, 'create', invoiceResource(...))` built from it.
- Documents and follow-ups on invoices inherit these permissions through the M7 and M5 registries.

### Status (`packages/core/status/invoice.ts`)

Pure functions, no database access, exported from `status/index.ts`.

- **`INVOICE_TRANSITIONS`**: `PENDING → PAID`, `PENDING → OVERDUE`, `OVERDUE → PAID`, plus `OVERDUE → PENDING` (a due-date correction only, Decision 7) and `PAID → PENDING | OVERDUE` (admin "Mark unpaid", Decision 8).
- `canTransitionInvoice(from, to, { by })` / `assertInvoiceTransition(...)`, where `by` is `'user' | 'system' | 'admin'`:
  - `→ PAID`: `user` or `admin`; requires `paidAt`.
  - `PENDING → OVERDUE`: `system` only (the job), or as the result of a due-date edit (below).
  - `PAID → *`: `admin` only.
- **`invoiceStatusForDueDate(status, dueDate, today)`**: for an unpaid invoice, `OVERDUE` when `dueDate < today` (IST calendar days), else `PENDING`. `PAID` is returned unchanged. The job, create and due-date edits all use it, so "overdue" has one definition.
- **`defaultDueDate({ invoiceDate, poPaymentTermsDays, companyDefaultDays })`** returns `{ dueDate, basis }`: `PO_TERMS` when the PO has net days (including 0), else `COMPANY_DEFAULT`. Shared with the form so the hint and the server agree.

### Schemas (`packages/core/schemas/invoice.ts`)

- Reuses `moneySchema`, `formatMoney`, `toAmountString`, `calendarDateSchema` and `requiredDay`.
- Form schemas keep `amount` as typed (`createInvoiceFormSchema`, `updateInvoiceFormSchema`); service schemas convert to `amountMinor` (M6/M8/M9 pattern).
- `invoiceNumber`: trimmed, internal whitespace collapsed, 1–64 chars; stored as typed, compared case-insensitively.
- `createInvoiceSchema`: `purchaseOrderId`, `invoiceNumber`, `invoiceDate`, `serviceId`, `amount` (> 0), `dueDate?` (omitted → default; given → `MANUAL` unless it equals the default), `paidAt?` + `paymentReference?` (create an already-paid invoice, for back-entry and M13 import), `description?`. **No `clientId`, `currency`, `status`, `dueDateBasis` or `documentId`.**
- `updateInvoiceSchema`: `invoiceNumber`, `invoiceDate`, `serviceId`, `amount`, `dueDate`, `paymentReference`, `description`, all optional (M3 empty-string convention). **No `purchaseOrderId`, `currency`, `status` or `paidAt`** (payment goes through `markInvoicePaid`).
- `markInvoicePaidSchema`: `{ id, paidAt, paymentReference? }`. `paidAt` not in the future and not before `invoiceDate`.
- `markInvoiceUnpaidSchema`: `{ id, reason }` (1–500 chars), stored in `unmarkedPaidReason` (Decision 8).
- `listInvoicesSchema`: `listParamsSchema` plus:
  - Filters: `status[]`, `purchaseOrderId`, `projectId`, `clientId`, `serviceId`, `managerId` (or `'none'`), `ownerId` (admins only), `currency[]`, `invoiceFrom/To`, `dueFrom/To`, `due` (`overdue | next7 | next30`), `document` (M9's `document-state`), `recordStatus`.
  - Search: `q` over invoice number, PO number, project number and name, client name, payment reference.
  - Sort: `invoiceDate` (default, desc), `dueDate`, `invoiceNumber`, `client`, `amount` (mixed currencies sort by minor units, as M6), `status`, `paidAt`, `createdAt`, `updatedAt`.
- `searchRecordsSchema`: `SearchResultType` gains `invoice`.

### Extraction (`packages/core/extraction`, `schemas/extraction.ts`, `schemas/document.ts`)

- **`INVOICE_EXTRACTION_FIELDS`**:
  - `invoiceNumber` (text ≤ 64): the invoice number as printed.
  - `invoiceDate` (date).
  - `dueDate` (date): only when printed.
  - `clientName` (text ≤ 200): the billed party ("Bill to"), not us.
  - `clientGstin` (text ≤ 15): the billed party's GSTIN, when printed. Normalised to upper case; nulled with low confidence if it fails the M3 format.
  - `poNumber` (text ≤ 64): the client PO number the invoice quotes, when printed.
  - `amount` (amount): the invoice grand total including taxes.
  - `currency` (currency).
- **Registry entry** (`extraction/kinds.ts`, `INVOICE`):
  - `parentModel: 'Invoice'`. `load` returns `Invoice <number>` and the client as the label, `invoiceResource`, and current values.
  - Review rows: `invoiceNumber → invoiceNumber`; `invoiceDate → invoiceDate`; `amount → amount` (money input, currency fixed to the PO's); `dueDate → dueDate`.
  - Info only: `clientName`, `clientGstin`, `poNumber`, `currency`.
  - **Mismatch warnings** (shown above the form, never blocking; UI guide 4.5):
    - Client: the M7 `company-name` comparison against the PO's client. When both the extracted and the client's GSTIN are present, GSTIN decides: equal → no warning even if names differ; different → warning even if names match.
    - PO: the extracted `poNumber` differs (case- and whitespace-insensitive) from the invoice's PO number.
    - Currency: the extracted currency differs from the PO's. The amount row is then unticked by default.
  - `locked`: none (Decision 9).
  - `setDocument`, `currentWhere: { invoice: { isNot: null } }`, `applyConfirmed` → `updateInvoice`, `visibleIds`/`labels` through the `INVOICE` follow-up target.
- `REVIEW_RECORD_SCHEMAS.INVOICE = updateInvoiceFormSchema`. `uploadDocument` now accepts `kind = INVOICE`; every `DocumentKind` is live.
- A duplicate invoice number or an invalid date pair on confirm fails the whole confirm with the field error (M7 AC6 semantics). Applying `invoiceDate` without `dueDate` moves a non-`MANUAL` due date with it (Decision 6), so the pair stays valid.

### Services (`packages/core/services/invoice.service.ts`)

Each function takes `ctx`, validates, calls `assertCan`, and writes inside `withTx` with conditional `updateMany` guards (the M4/M5 race fix; "Someone else changed this invoice"). Unique violations go through `guardUnique`.

**Locking.** Every invoice write first takes **`lockPurchaseOrder(tx, poId)`** (new, in `purchase-order-lock.ts`, the `lockProject` pattern keyed `purchase-order:<id>`). Callers that also lock the project take the project lock first (M9 lock order). This serialises writes on one PO so each `recomputePurchaseOrderStatus` sees the committed set of invoices.

- `listInvoices(ctx, input)`: `scopeInvoices` ANDed with filters. `Page<InvoiceRow>` with client, PO number, project number and name, service, formatted amount, due date, days overdue, status and document state.
- `getInvoice(ctx, id)`: not visible → `NotFoundError`. Includes the PO (number, amount, status, terms), project, quotation and enquiry ids for the pipeline strip, service, document summary, the PO's billing totals (below), and `canUpdate`, `canMarkPaid`, `canMarkUnpaid`, `canDelete` (with reasons).
- `getInvoiceDraft(ctx, purchaseOrderId)`: form defaults.
  - Client and currency from the PO; `serviceId` when the PO has exactly one service.
  - `amount` = PO amount − live invoices' total; blank when zero or less.
  - `invoiceDate` = today (IST); `dueDate` and `basis` from `defaultDueDate`, plus the hint text ("Net 45 from PO 4500012345" / "Company default, 30 days").
  - The PO must be live and readable.
- `createInvoice(ctx, input)`:
  - The PO must be live and readable, else `NotFoundError`. A cancelled project is allowed (Decision 5).
  - Locks the PO. `clientId` and `currency` copied from the PO. `serviceId` must be one of the PO's services.
  - Invoice number unique among live invoices: `DomainError` "Invoice <number> already exists (on PO …)", backed by the partial index.
  - `dueDate` / `dueDateBasis` from `defaultDueDate` when omitted; `MANUAL` when given and different; `dueDate ≥ invoiceDate`.
  - Status: `PAID` when `paidAt` is given, else `invoiceStatusForDueDate(PENDING, dueDate, today)` (a back-dated invoice is `OVERDUE` at once; Decision 7). `statusChangedAt = now`.
  - Calls `recomputePurchaseOrderStatus(tx, poId)` in the same transaction.
  - Returns the invoice and a `billing` result with a non-blocking warning when live invoices now exceed the PO amount (Decision 9).
- `updateInvoice(ctx, id, input)`:
  - `update` permission. Uniqueness and service re-checked only when they change.
  - `invoiceDate` changed and `dueDate` not given: a non-`MANUAL` due date is recomputed from the **current** PO terms and settings; a `MANUAL` one is kept and must still be ≥ the new date.
  - `dueDate` given: basis becomes `MANUAL` unless it equals the default.
  - For an unpaid invoice, re-derives the status with `invoiceStatusForDueDate` and applies it through the status machine (`OVERDUE ⇄ PENDING`; Decision 7).
  - Amount or status changed → `recomputePurchaseOrderStatus` in the same transaction.
  - A `PAID` invoice stays editable (corrections), except `invoiceDate` must stay ≤ `paidAt`.
- `markInvoicePaid(ctx, { id, paidAt, paymentReference })`: `update` permission (Decision 14). `PENDING | OVERDUE → PAID` through `assertInvoiceTransition`; recompute the PO. Already `PAID` → `DomainError` "This invoice is already marked paid".
- `markInvoiceUnpaid(ctx, { id, reason })`: admins only (a service check on `ctx.user.role`, like M8's admin-only cancel). Clears `paidAt` and `paymentReference`, sets `unmarkedPaidReason` and the status from `invoiceStatusForDueDate`, and recomputes the PO. `markInvoicePaid` clears `unmarkedPaidReason` again.
- `softDeleteInvoice` / `restoreInvoice`: `delete` permission; a `PAID` invoice may be deleted only by admins (Decision 10). Both recompute the PO. Restore needs a live PO and a free invoice number. The document stays attached (M9 pattern).
- `listInvoicesForPurchaseOrder(ctx, poId)`, `listInvoicesForProject(ctx, projectId)`, `listInvoicesForClient(ctx, clientId)`: scoped.
- **`markOverdueInvoices(systemCtx, { today = todayInIST() })`** (exported for the worker only; `source: 'system'`):
  - Finds live `PENDING` invoices with `dueDate < today`, in batches of 100 by id.
  - Per invoice, its own transaction: lock the PO, re-read with a guarded `updateMany where status = PENDING and dueDate < today`, transition to `OVERDUE`, recompute the PO. One failure is logged and does not stop the rest.
  - Safety net: then recomputes every live PO that has an `OVERDUE` invoice but is not `OVERDUE` itself (M9 risk "stored status can drift"); each correction is an audited `system` write.
  - Idempotent: a second run the same day writes nothing. Returns `{ markedOverdue, posRecomputed, failed }`.

**Purchase order side** (`purchase-order.service.ts`, `purchase-order-status.ts`):

- `liveInvoicesFor(tx, poId)` now queries live invoices (`status`, `amountMinor`). The test-only loader parameter stays; a test asserts no production caller passes one (M9 risk).
- `softDeletePurchaseOrder` takes the project lock then the PO lock, and refuses while the PO has live invoices: "Delete this PO's invoices first (N)". `canDelete` gives that reason.
- `updatePurchaseOrder`: changing `currency` is refused while the PO has live invoices ("Invoices on this PO are in INR"). Lowering the amount below the invoiced total is **allowed with a warning** (Decision 9).
- `getPurchaseOrder` and `getProject` return `billing` per PO: `invoiced`, `paid`, `outstanding`, `overdue` (in the PO currency), and invoice counts. `getProject` adds per-currency totals across POs.
- `getQuotation`, `getEnquiry`, `getProject`, `getPurchaseOrder` gain what the pipeline strip needs for the Invoice stage: whether a live invoice exists below, and its id when there is exactly one.

**Settings side**: changing `CompanySettings.defaultInvoiceDueDays` or a PO's `paymentTermsDays` never rewrites existing due dates (Decision 6).

**Follow-up target** (`follow-up-targets.ts`): `INVOICE` entry — `auditModel: 'Invoice'`, label `Invoice <number>`, `invoiceResource`, `visibleIds` via `scopeInvoices`, `labels`, `pickable`. No `afterChange`. `scopeFollowUps` gains the branch.

**Timeline** (`timeline.service.ts`): invoice `CREATED`, `DELETED`, `RESTORED` and `STATUS_CHANGE` (Pending → Overdue shown as "System"; → Paid shows `paidAt`). PO status changes (mapped in M9) now appear for real. Amount and date edits stay on the Audit tab. Invoice documents come through the M7 `DOCUMENT` kind.

**Search**: invoices by number, scoped; detail line is client name and PO number.

**Summary** (`summary.service.ts`): `invoiceStatusCounts(ctx)` returns `PENDING`, `OVERDUE`, `PAID`, `dueNext7` (unpaid, due today to +7 days) and `toReview`, scoped like the list. Receivables values and ageing are M12.

### Worker (`apps/worker`)

- Registers an `invoices:mark-overdue` job on the existing `system` queue through a BullMQ job scheduler (`upsertJobScheduler('invoices:mark-overdue', { pattern: '5 0 * * *', tz: 'Asia/Kolkata' })`), so it runs at 00:05 IST and a restart does not duplicate it.
- The processor calls `markOverdueInvoices(await systemCtx())` and logs the counts. Retries: 3 attempts, backoff from 60 s.
- **Catch-up on start:** the worker also runs it once on start (after the document sweep), so a day the worker was down is not missed. Safe because the job is idempotent.
- The `system` queue's no-op processor from M0 becomes a small name-to-handler map.

### Seed

- Development only, through the services in the seed transaction with `source: 'system'`, added when no invoices exist (the M5–M9 pattern). Dates are relative to today (IST).
  - A PO fully invoiced and paid → PO `PAID`.
  - A PO with a paid advance invoice (50%) → PO `PENDING`.
  - A PO with an invoice due 10 days ago, marked `OVERDUE` by calling `markOverdueInvoices` → PO `OVERDUE`.
  - An invoice due in 3 days (M11's "invoice due"), one on the PO with `paymentTermsDays = 45` (`PO_TERMS`), one on a text-only-terms PO (`COMPANY_DEFAULT`).
  - One follow-up on the overdue invoice ("Chased accounts; payment promised Friday").
  - At least one PO with no invoices, so the create flow can be tried by hand.
- `seed:documents` gains `test/fixtures/documents/globex-invoice.pdf` attached to one seeded invoice, with a `mockExtractor` fixture whose client name differs, to show the warning.

### Web (`apps/web`)

Follows `docs/UI-GUIDE.md` (templates 4.1, 4.2, 4.5; `--stage-invoice`; invoice status badges; saffron only for overdue/due today) and its checklist.

- **Nav:** **Invoices** after Purchase orders with `stage: 'invoice'`, shown when `can(user, 'list', 'invoice')`. **+ New → Invoice** opens `/invoices/new`.
- **`/invoices`** (list, 4.1):
  - Summary strip: Pending, Overdue (attention), Due in 7 days, Paid, To review — clickable chips.
  - Columns: invoice number (link), client, PO number, project, invoice date, due date (with "in 5 days" / "12 days overdue", saffron when overdue or due today), amount (`<Money>`), status, document state, updated.
  - Filters: status, due window, client, project, PO, service, currency, invoice and due ranges, document state, search; manager (admins, Sales, incl. Unassigned), owner (admins). "Deleted" view with Restore.
  - Row action **Mark paid** for users who can.
- **`/invoices/new?purchaseOrderId=…`** (full page, max 880px):
  - Without `purchaseOrderId`, the first field is a PO combobox (live POs the user can read; number, client, project).
  - Pre-filled from `getInvoiceDraft`: client (read-only, "From PO …"), currency (read-only), service, amount ("Remaining on PO …"), invoice date, due date with the basis hint under it. Changing the invoice date recomputes the due date until the user edits the due date by hand ("Custom due date" + a **Reset** link).
  - Sections: **Invoice** (number, invoice date, service, amount), **Payment** (due date; an "Already paid" checkbox revealing paid date and reference), **Notes**, **Document** (optional drop zone, as M9).
  - Warning Alert when invoices would exceed the PO amount, with both totals; does not block.
  - Submit creates the invoice, then uploads the file with `kind = INVOICE`, then goes to the invoice (M9 Decision 3 flow and error toast).
- **`/invoices/[id]/edit`**: same page; PO read-only; no Document or "Already paid" section.
- **`/invoices/[id]`** (detail, 4.2):
  - Breadcrumb `Invoices / <number>`. Header `Invoice <number>`, `<client> — PO <poNumber>` beneath, status badge, `[Mark paid]` (primary, when unpaid) `[Log follow-up]` `[Edit]` `[⋯]`.
  - **Mark paid** dialog: paid date (default today), reference; `[Cancel] [Mark paid]`.
  - Pipeline strip: all five stages filled and linked, Invoice current.
  - Tabs: Overview | Timeline | Documents | Audit.
  - Overview: field grid (number, invoice date, service, amount, due date with basis, paid date, reference, description) and the M7 **Document** card (`INVOICE`, "Upload invoice").
  - Side panel: client, PO (link, status badge), project, manager, owner, amount, due date (relative, saffron when overdue), and "This PO: invoiced ₹X of ₹Y, paid ₹Z".
  - `⋯`: **Mark unpaid** (admins, on paid invoices; asks for a reason), **Delete** ("Delete invoice INV/26-27/0042?").
- **`/purchase-orders/[id]`**: the **Invoices** section replaces M9's empty state — compact table (number, date, due, amount, status, document state), a billing line "Invoiced ₹6,00,000 of ₹10,00,000 · Paid ₹5,00,000", over-invoiced warning style, `[Add invoice]`. The status note "Status follows this PO's invoices" stays. `⋯ → Delete` explains "Delete its invoices first" when blocked.
- **`/projects/[id]`**: the PO table gains Invoiced and Paid columns; the Documents tab adds invoice documents; the pipeline strip links the Invoice stage (to the invoice when exactly one, else the filtered list).
- **`/quotations/[id]`**, **`/enquiries/[id]`**: the Invoice stage fills and links as above.
- **`/clients/[id]`**: **Invoices** sidebar section (latest ten, overdue first), timeline record filter `?record=INVOICE:<id>`, invoice documents in Documents.
- **`/documents/[id]/review`**: `INVOICE` labels and back-link; the three mismatch warnings.
- `follow-up-labels.ts` `recordHref` for invoices; ⌘K invoice results; `StatusBadge` gains `invoice` (Pending neutral, Paid success, Overdue attention).

## Out of scope

- Partial payments, TDS deductions and payment allocation (Decision 13): v1 marks an invoice paid in full.
- Generating invoices, GST computation, credit notes, e-invoicing (IRN) and sending invoices to clients. The accounting system stays the source; this app records them.
- Invoices without a PO or across POs; moving an invoice to another PO.
- Currency conversion, receivables value, ageing buckets and DSO: M12. My Today rows: M11. Email reminders: M11/M14.
- MCP tools and bulk import of invoices: M13 (the create schema already accepts `paidAt` for it).

## Acceptance criteria

**Service and data** (integration tests against the test database, `memoryFileStore`, `mockExtractor`, a fixed `today`):

1. **AC1 (create and defaults):**
   - Creating on a PO with `paymentTermsDays = 45` and no due date gives `invoiceDate + 45`, basis `PO_TERMS`; on a PO without net days, `+ defaultInvoiceDueDays`, `COMPANY_DEFAULT`; `paymentTermsDays = 0` gives the invoice date. A given different due date is `MANUAL`.
   - Client and currency come from the PO; status `PENDING`; one audit `CREATE` row with `source` and `requestId`.
   - A back-dated invoice whose due date is before today is created `OVERDUE`; one with `paidAt` is created `PAID`.
   - `getInvoiceDraft` returns the remaining PO amount, then blank once fully invoiced; the single service; and the basis hint.
2. **AC2 (validation):** field errors for a missing number, a future invoice date, `amount ≤ 0`, a due date before the invoice date, a service not on the PO, a duplicate number (any case, any client), a soft-deleted or unreadable PO (not found), `paidAt` in the future or before the invoice date. Unknown keys `clientId`, `currency`, `status`, `dueDateBasis`, `documentId` are rejected, and `purchaseOrderId`/`paidAt` in update input.
3. **AC3 (RBAC):**
   - Lists: PM sees invoices on their projects only, Sales under their quotations only, admins all. Others get not found for the invoice and its document.
   - PM and pipeline owner can create, update, mark paid, delete and restore; on an unassigned project only the owner and admins.
   - Only admins can mark unpaid or delete a `PAID` invoice.
   - Reassigning the project's PM or the quotation's owner moves invoices between lists.
   - Every service function has happy-path, denial and audit-row tests.
4. **AC4 (status machine, unit):** every pair in `INVOICE_TRANSITIONS` allowed for its actor and refused for the others; `PAID` without `paidAt` refused; `invoiceStatusForDueDate` at due = yesterday, today and tomorrow (IST, including 23:30 IST = 18:00 UTC edge); `defaultDueDate` for 45, 0, null days.
5. **AC5 (the "done when"):**
   - With `today` fixed, `markOverdueInvoices` turns every live `PENDING` invoice with `dueDate < today` to `OVERDUE`, leaves due-today, `PAID`, deleted and already-`OVERDUE` ones alone, and writes audit rows with `source = 'system'`.
   - A second run writes nothing. A failure on one invoice (forced) does not stop the others and is counted.
   - Each affected PO is `OVERDUE` afterwards, with its own `system` audit row in the same transaction.
   - The safety net corrects a PO whose status was forced by raw SQL.
   - The worker processor calls it with a system context; the scheduler is registered once across two `startWorker` calls.
6. **AC6 (PO status follows invoices; M9's "done when" end to end):** on a ₹10L PO, asserting the PO status after each step:
   - no invoices → `PENDING`; ₹5L invoice → `PENDING`; ₹5L marked paid → `PENDING`; second ₹5L invoice → `PENDING`; it goes overdue (job) → `OVERDUE`; marked paid → `PAID`;
   - amount lowered to ₹4L → `PENDING`; soft-deleted → `PAID` again if the rest cover it, else `PENDING`; restored → back;
   - mark unpaid (admin) → `PENDING`/`OVERDUE`; due date edited later on an `OVERDUE` invoice → invoice `PENDING`, PO recomputed.
   - A grep-style test: only `packages/core/status/invoice.ts` callers in `invoice.service.ts` write `Invoice.status`, and M9's test (only `recomputePurchaseOrderStatus` writes PO status) still passes.
7. **AC7 (document and extraction):**
   - Uploading an `INVOICE` document works; the invoice is unchanged until confirm.
   - Confirming number, date and `amount = "5,90,000"` updates the invoice through `updateInvoice` and marks the document `CONFIRMED`, one `requestId`. Confirming `invoiceDate` alone moves a `PO_TERMS` due date and keeps a `MANUAL` one (failing with the field error if it would precede the date).
   - Client warning: name differs → warning; names differ but GSTINs equal → none; names match but GSTINs differ → warning. PO-number and currency mismatches warn.
   - A duplicate invoice number on confirm fails with nothing written.
8. **AC8 (PO interplay):** `softDeletePurchaseOrder` refused with live invoices and allowed after they are deleted; PO currency change refused with invoices; PO amount below invoiced total saves with a warning; invoices over the PO amount save with a warning; invoices can be created on a cancelled project's PO; `getPurchaseOrder`/`getProject` billing totals match.
9. **AC9 (follow-ups, timeline, search):** a follow-up on an invoice shows on the client timeline for the PM, owner and admins, not another PM; timeline shows invoice create/delete/restore and Pending → Overdue ("System") → Paid in date order; ⌘K finds an invoice by number only for readers.
10. **AC10 (list):** each filter narrows correctly (including `due = overdue | next7`, manager `none`, document state), sorts and pagination work, filters AND with scope, and `invoiceStatusCounts` matches the filtered list per chip.
11. **AC11 (concurrency, 10 rounds each):** two creates with the same number → exactly one; an invoice create racing `softDeletePurchaseOrder` → never a live invoice on a deleted PO; two concurrent invoice writes on one PO → the PO status equals `derivePurchaseOrderStatus` of the final invoices; `markOverdueInvoices` racing `markInvoicePaid` on the same invoice → ends `PAID`, PO consistent.
12. **AC12 (seed):** `pnpm db:seed` on an M9 database adds the sample invoices once, with one PO each `PAID`, `PENDING` (partly paid) and `OVERDUE`.

**End-to-end** (Playwright, local store + `mockExtractor`):

13. **AC13 (invoice flow):** the PM opens a seeded PO, adds an invoice with the file, sees "Net 45 from PO …", reviews the extraction (client warning shown), confirms, marks it paid, and sees the PO badge change. A second PM gets not found at the invoice URL and its review URL. **Delete** on the PO explains its invoices must go first.
14. **AC14 (full pipeline, CLAUDE.md):** `pipeline.spec.ts` — a Sales user creates an enquiry → converts → quotation → `PO_RECEIVED` → project (assigning a PM) → PO → invoice → mark paid; every pipeline strip stage is filled and linked at the end.

**Quality:**

15. **AC15:** `pnpm typecheck && pnpm lint && pnpm test` pass. `m10_invoices` applies after M9. `Invoice` passes the M2 audit coverage test. A test asserts the partial unique index and the CHECKs exist. UI guide checklist run on every new screen.

## Decisions

1. **An invoice belongs to one PO**, and its client is the PO's, fixed (M9 Decision 1). The project and pipeline owner are read through the PO, never copied.
2. **The invoice number is ours and unique company-wide** among live invoices, case-insensitive, by partial index. Unlike PO numbers (the client's, unique per client), we issue invoice numbers, so two clients can never share one. Indian invoice series usually carry the financial year ("INV/26-27/0042"), so a company-wide rule does not block year resets.
3. **Invoices are in their PO's currency** (M9 "For M10"), copied and not editable, because `derivePurchaseOrderStatus` sums amounts. A PO's currency cannot change once it has invoices.
4. **One service per invoice** (CLAUDE.md), chosen from the PO's. A bill covering two services is recorded as the main one; M12's service reports accept that approximation. Revisit if it distorts reports.
5. **Invoices are allowed on a cancelled project's POs**, settling M9 Decision 11: work done before cancellation is still billed.
6. **The due date is stored with its basis.** `PO_TERMS` / `COMPANY_DEFAULT` due dates follow invoice-date edits, `MANUAL` ones do not. Later changes to PO terms or company settings never rewrite existing invoices — the due date the client was given is what counts.
7. **"Overdue" is one function, applied on every relevant write.** The nightly job is the main path (CLAUDE.md), but create and due-date edits also apply `invoiceStatusForDueDate`, so a back-dated invoice is `OVERDUE` at once and correcting a wrong due date moves `OVERDUE` back to `PENDING`. This adds `OVERDUE → PENDING` (by due-date correction only) to CLAUDE.md's machine (confirmed by the product owner; CLAUDE.md and PLAN.md now say so).
8. **Mark unpaid is admin-only** and needs a reason. The reason is stored on the row (`unmarkedPaidReason`), so the M2 audit row carries it with no audit change, and the timeline shows it on the status change. It exists because a wrongly marked payment otherwise needs a DB fix. Adds `PAID → PENDING | OVERDUE` for admins (confirmed by the product owner; CLAUDE.md and PLAN.md now say so).
9. **Over-invoicing warns, never blocks** (the M9 Decision 6 reasoning: POs are often pre-tax, invoices post-tax). The PO amount may be lowered below the invoiced total with a warning, so nothing is locked in the `INVOICE` or `PURCHASE_ORDER` document kinds.
10. **Deleting a `PAID` invoice is admin-only**, so receivables history is not lost by accident; unpaid invoices follow the M1 policy (owner, PM, admin), matching M9 Decision 10.
11. **Record first, document second** (M9 Decision 3): the form pre-fills from the PO; the user types the invoice number and uploads the PDF; extraction proposes corrections.
12. **Every invoice write locks the PO** (after the project lock when both are held), so concurrent invoice writes and the nightly job never leave a stale PO status.
13. **No partial payments in v1** (confirmed by the product owner). An invoice is paid in full or not; split billing is several invoices. A payment short by TDS is marked paid in full, and the reference can note the deduction. An informational received amount or a `Payment` model can come later without changing the status rules.
14. **Anyone who can update an invoice can mark it paid** (confirmed by the product owner): the pipeline owner, the project's PM and admins, per the M1 policy unchanged. Only reversing a payment is admin-only (Decision 8).

## For M11 (My Today) and M12 (reports)

- M11: "invoice due" = unpaid, `dueDate` today to +7 days; "invoice overdue" = `status = OVERDUE`, both scoped by `scopeInvoices`, via the `(status, dueDate)` index. Invoice follow-ups' `nextFollowUpDate` feed "follow-up due".
- M12: receivables = unpaid live invoices; ageing from `dueDate`; revenue billed/collected from `invoiceDate`/`paidAt`. Amounts include tax (Decision 9); currency conversion is M12's open question.

## Dependencies

None new. BullMQ job schedulers are in the installed `bullmq` 6.3.9. Reuses M3–M9 components (DataTable, FilterBar, SummaryStrip, StatusBadge, PipelineStrip, Money, Timeline, FollowUpSheet, Document card, review screen), `moneySchema`, `calendarDateSchema`, `requiredDay`, `todayInIST`, `guardUnique`, `company-name.ts`, `document-state.ts` and the upload route.

## Risks

- **Time zones.** "Past due" is an IST calendar comparison. A job at 00:05 IST is 18:35 UTC the previous day; tests must pin `today` and cover the boundary (AC4). Never compare `dueDate` with `new Date()`.
- **A missed or failed nightly run** leaves invoices `PENDING` past due. Mitigations: catch-up on worker start, retries, and create/edit applying the rule themselves. M14 should alert when the job has not succeeded in 26 hours.
- **PO status drift** (M9 risk). Mitigations: recompute in every write, the PO lock, the job's safety net, and AC6/AC11.
- **Scope depth.** `scopeInvoices` joins invoice → PO → project → quotation. Measure `listInvoices`, `listFollowUps`, `listDocuments` and the client timeline on the seed; the SQL-view fallback M5 suggested still applies.
- **Partial unique index and Prisma.** Keep the schema comment and the existence test (AC15).
- **Mismatch warning noise.** Invoices often print a trading name or a branch GSTIN. Watch the warning rate on real data before making anything stricter.

## Open questions

Settled by the product owner: no partial payments in v1 (Decision 13); anyone who can update an invoice marks it paid (Decision 14); `OVERDUE → PENDING` on a due-date correction and admin-only Mark unpaid (Decisions 7 and 8). CLAUDE.md and PLAN.md are updated to match.

None open.
