# M11 — My Today

Depends on: M0, M1, M2, M3, M4, M5, M6, M7, M8, M9, M10.

## Goal

Each user opens the app to one list of what needs them today: follow-ups that are due or missed, quotations waiting on the client, invoices due or overdue, enquiries that have gone quiet, projects past their end date, and documents waiting for review. Every row links to its record and offers the next action in place (log a follow-up, mark paid, review), so the list shrinks as the day's work gets done.

- A read-only **`getMyToday`** service in `packages/core` that assembles the rows from the existing tables, scoped by RBAC and filtered to the user's own responsibilities.
- One definition per row type, reusing the rules earlier modules already wrote (`ACTIVE_QUOTATION_STATUSES`, `dueWindowWhere`, M8's behind-schedule rule, `listDocumentsPendingReview`), so My Today and the list pages always agree.
- A **`/today`** page (UI guide 4.4, "My today") that becomes the home page, and a **My today** nav item with a count badge.
- One new setting, **`CompanySettings.staleEnquiryDays`** (default 30).

PLAN.md "done when": shows correct items for seeded data. AC1 proves it with a golden test over the development seed for each seeded user.

## In scope

### Row types

Every row has a `kind`, the record it points to, the client, a one-line "what to do", and a **`dueDate`** (an IST calendar day). The page groups rows by `dueDate` alone (Decision 3). `today` is `todayInIST()`; the look-ahead is `today + 7` days.

| Kind                       | Rows for                                                   | Included when                                                                                                                     | `dueDate`                       | "What to do"                                            |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| `INVOICE_OVERDUE`          | Project's PM and pipeline owner (quotation's `ownerId`)    | Live invoice, `status = OVERDUE`                                                                                                  | `dueDate`                       | "Chase payment — 12 days overdue"                       |
| `INVOICE_DUE`              | Same                                                       | Live invoice, `status = PENDING`, `dueDate` today to +7 (`dueWindowWhere('next7')`)                                               | `dueDate`                       | "Payment due"                                           |
| `QUOTATION_AWAITING_REPLY` | Quotation owner                                            | Live quotation, `status ∈ ACTIVE_QUOTATION_STATUSES`, `nextFollowUpDate ≤ today + 7`                                              | `nextFollowUpDate`              | "Follow up on QUO-2026-0042" + `lastFollowUpHighlights` |
| `FOLLOW_UP_DUE`            | See Decision 2                                             | The **latest** live follow-up on a record (M5 Decision 1) has `nextFollowUpDate ≤ today + 7` and the record is still open (below) | `nextFollowUpDate`              | The latest follow-up's notes, truncated                 |
| `PROJECT_BEHIND_SCHEDULE`  | Project's PM                                               | Live project, `status ∈ ACTIVE_PROJECT_STATUSES`, `endDate < today` (M8's rule)                                                   | `endDate`                       | "Past planned end — 64% complete"                       |
| `STALE_ENQUIRY`            | Enquiry owner                                              | Live enquiry, `IN_PROGRESS`, no open follow-up (Decision 5), last touch ≤ today − `staleEnquiryDays`                              | last touch + `staleEnquiryDays` | "No activity for 34 days"                               |
| `DOCUMENT_TO_REVIEW`       | `listDocumentsPendingReview` (uploader + record owner, M7) | Current document, extraction `SUCCEEDED`, review `PENDING`                                                                        | `extractedAt` (IST day)         | "Review extracted fields"                               |

**"Record still open"** for `FOLLOW_UP_DUE`:

- `CLIENT`: client live.
- `ENQUIRY`: live and `IN_PROGRESS` (a converted enquiry's follow-ups move to its quotation).
- `QUOTATION`: never — the quotation row covers it, since M6 syncs the latest follow-up's next date onto `Quotation.nextFollowUpDate` (M6 Decision 5).
- `PROJECT`: live and in `ACTIVE_PROJECT_STATUSES`.
- `PURCHASE_ORDER`: live and not `PAID`.
- `INVOICE`: live and not `PAID`.

In every case the record's client must also be live, and the responsible user must still be able to read the record (its registry `visibleIds`).

**One row per record** (Decision 4). When a record qualifies for more than one kind (an overdue invoice with a chase follow-up due, a stale enquiry with a missed follow-up), the row takes the highest-priority kind in this order: `INVOICE_OVERDUE`, `INVOICE_DUE`, `QUOTATION_AWAITING_REPLY`, `FOLLOW_UP_DUE`, `PROJECT_BEHIND_SCHEDULE`, `STALE_ENQUIRY`. Its `dueDate` is the earliest of its reasons, and the other reasons are listed as `alsoReasons` ("Follow-up due 2 Oct"). Document rows are keyed by the document, so they never merge with their record's row.

### Database (`packages/db`)

- **`CompanySettings.staleEnquiryDays Int @default(30)`**, `CHECK` between 1 and 365 in the migration SQL.
- No new tables. The existing indexes already serve M11: `FollowUp (entityType, entityId, date)` and `(userId, nextFollowUpDate)`, `Quotation (ownerId, status, nextFollowUpDate)`, `Enquiry (ownerId, status)`, `Project (managerId, status)`, `Invoice (status, dueDate)`, `Document (uploadedById, reviewStatus)`.
- Migration: `m11_my_today`.

### RBAC (`packages/core/rbac`)

- New resource **`myToday`**, instance `{ type: 'myToday'; userId: string }`:
  - `read`: `userId === user.id`, for every role.
  - Admins may read any active, non-system user's My Today (Decision 6).
- Every source query ANDs the entity's existing scope function (`scopeInvoices`, `scopeQuotations`, `scopeEnquiries`, `scopeProjects`, `scopeFollowUps`) **for the viewed user** with that user's responsibility filter. So a row can never show a record its user cannot read, and an admin viewing a Sales user sees exactly that user's list.

### Schemas (`packages/core/schemas/my-today.ts`)

- `MY_TODAY_KINDS` (the seven kinds, priority order) and `myTodayKindSchema`.
- `myTodaySchema`: `{ userId?: string }`. Omitted means the actor.
- `MyTodayRow`: `{ key, kind, dueDate, daysFromToday, record: { type, id, label, href }, client: { id, name }, title, detail?, alsoReasons: { kind, dueDate }[], amount?: { amountMinor, currency } (invoices), actions: MyTodayAction[] }`, where `MyTodayAction` is `'LOG_FOLLOW_UP' | 'MARK_PAID' | 'REVIEW' | 'OPEN'`, computed from the viewer's permissions (Decision 6).
- `settingsSchema` gains `staleEnquiryDays` (integer 1–365).

### Services (`packages/core/services/my-today.service.ts`)

Read-only: no writes, no transaction, no audit rows.

- **`getMyToday(ctx, input, { today = todayInIST() })`**:
  - Resolves the viewed user (actor, or `input.userId` for admins; unknown, inactive or system user → `NotFoundError`). `assertCan(ctx, 'read', { type: 'myToday', userId })`.
  - Runs one query per source in parallel, each bounded to `dueDate ≤ today + 7` in SQL, then merges, dedupes by record (above), and sorts by `dueDate` asc, kind priority, client name, record label.
  - Returns `{ today, user: { id, name }, sections: { overdue, dueToday, comingUp }, counts: { overdue, dueToday, comingUp, byKind } }`. `overdue` is `dueDate < today`, `dueToday` is `= today`, `comingUp` is today + 1 to + 7.
  - Each section returns at most **100 rows**; `counts` are exact, and the page shows "Showing 100 of 143" with links to the filtered lists (Decision 7).
- **`myTodayBadgeCount(ctx)`**: `overdue + dueToday` for the actor, for the nav badge. Same code path as `getMyToday` (a shared `collectRows`), so the two never disagree.
- **Follow-up source**: the latest live follow-up per `(entityType, entityId)`, by `date` desc then `createdAt` desc (the `getLatestFollowUp` ordering), via one `DISTINCT ON` query in `$queryRaw` inside core (reads only; CLAUDE.md rule 3 governs writes). Then filtered by open record, responsibility and scope.
- **Stale enquiry source**: last touch = the later of `receivedDate` and the latest live follow-up's `date` on the enquiry. "No open follow-up" = the latest follow-up has no `nextFollowUpDate`, or none exists. An enquiry whose latest follow-up is missed shows as `FOLLOW_UP_DUE`, not stale.
- Label and link helpers come from the M5 follow-up registry (`labels`) and the web's `recordHref`, so row labels match the timeline.

**Enquiries list**: `listEnquiriesSchema` gains `stale=true` (the same predicate, exported as `staleEnquiryWhere(today, days)`), so the "Showing 100 of N" link and a future summary chip can open it.

### Seed

- `CompanySettings.staleEnquiryDays = 30` (the migration default).
- Top up the development seed so every row type exists for at least one seeded Sales user and one seeded PM, with dates relative to today (IST): a missed, a due-today and a +3-day follow-up; a quotation follow-up missed and one due today; an overdue and a due-in-3-days invoice (M10 seed); a project past its end date; an enquiry received 45 days ago with no follow-up; a document awaiting review (`seed:documents`).
- Include one case per dedupe rule (an overdue invoice with a chase follow-up due; a stale enquiry with a missed follow-up) and one of each exclusion (a follow-up superseded by a newer one, a follow-up on a `PAID` invoice, a `LOST` quotation with an old next date), so the golden test checks both.
- Idempotent, as M4–M10: added only when the marker rows are missing.

### Web (`apps/web`)

Follows `docs/UI-GUIDE.md` 4.4 ("My today") and its checklist.

- **Route `/today`**. `/` redirects to `/today`; the M4–M10 Home page and its tiles are removed (their counts live on the list summary strips, and M12's Dashboard takes the overview role).
- **Nav:** **My today** is the first item for every role, with the count badge (`--attention-soft` / `--attention-foreground`) when `myTodayBadgeCount > 0`. The Home item goes.
- **Page:**
  - `PageHeader` "My today" · "Monday, 28 September" (IST). Admins get a **Viewing** select (Me, then active users by name) in the header actions, synced to `?user=`.
  - Three `Panel`s with counts: **Overdue** (saffron), **Due today** (saffron), **Coming up** (next 7 days). An empty panel says so in one line ("Nothing overdue"); when all three are empty, a single empty state: "You're clear for today."
  - Row: kind icon, `Client — title`, record label (link), muted `detail` and `alsoReasons`, due date (relative: "3 days overdue", "Today", "Thu 1 Oct"), amount for invoice rows (`<Money>`), then actions.
  - Actions: **Log follow-up** (the M5 `FollowUpSheet` with the record fixed), **Mark paid** (the M10 `PaymentDialogs` dialog, moved to a shared component), **Review** (the M7 review screen), **Open**. Only those in the row's `actions`.
  - After an action succeeds, the page refreshes; a row that no longer qualifies collapses (150 ms, respecting `prefers-reduced-motion`) and a toast confirms ("Follow-up logged", "Invoice marked paid"). A row that moves (a new next date next week) reappears in Coming up.
  - Filter chips by kind above the panels (Follow-ups, Quotations, Invoices, Projects, Enquiries, Documents), synced to `?kind=`.
  - Mobile: rows stack, actions move into a `⋯` menu.
- **Admin settings:** "Stale enquiry after (days)" in Company settings.
- **UI guide:** section 4.4's row-type list gains "project behind schedule" and "document to review"; section 11's "not built yet" note drops My today.

## Out of scope

- Reminders: the notification bell, email or WhatsApp digests, and push notifications. The daily email digest is M14 (Decision 11).
- Tasks or to-dos not tied to a record, and snoozing or dismissing a row. The way to move a follow-up is to log one with a new next date (M5 Decision 1).
- A team view (all users' rows in one list) and manager roll-ups: M12 dashboards.
- Calendar integration.
- MCP tools for My Today: M13 may add a `my_today` read tool on this service.

## Acceptance criteria

**Service and data** (integration tests against the test database, fixed `today`):

1. **AC1 (the "done when", golden test):** after `pnpm db:seed` with `today` pinned, `getMyToday` for each seeded Sales user, PM and the admin returns exactly the expected rows (kind, record label, section) from a checked-in fixture, including the dedupe and exclusion cases.
2. **AC2 (follow-ups):**
   - Only the latest live follow-up per record counts: logging a newer one with a later next date moves the row; with no next date, removes it. Deleting the newer one brings the old row back.
   - Excluded when the record is closed (enquiry converted or lost, project completed or cancelled, PO or invoice paid), soft-deleted, or its client is soft-deleted.
   - Quotation follow-ups never appear as `FOLLOW_UP_DUE`.
   - Responsibility follows Decision 2: reassigning an enquiry moves its follow-up rows to the new owner; a client-level follow-up stays with its author; a PM who loses a project loses its follow-up rows.
3. **AC3 (quotations):** `SENT` and `UNDER_NEGOTIATION` quotations with `nextFollowUpDate ≤ today + 7` appear for the owner; `PO_RECEIVED`, `LOST` and deleted ones never do, whatever their stored date; reassigning the owner moves the row.
4. **AC4 (invoices):** `OVERDUE` invoices appear for the project's PM and the pipeline owner; `PENDING` ones due today to +7 appear as due; due +8, `PAID` and deleted ones do not; an unassigned project's invoices appear for the owner only. The row counts match `invoiceStatusCounts` (`OVERDUE`, `dueNext7`) for a Sales user whose pipeline has no shared PMs.
5. **AC5 (stale enquiries):** with `staleEnquiryDays = 30`, an `IN_PROGRESS` enquiry last touched 30 days ago appears (due today) and one touched 29 days ago does not; a follow-up with a future next date makes it not stale; a missed next date shows it as `FOLLOW_UP_DUE`. Changing the setting to 60 changes the result. `listEnquiries({ stale: true })` returns the same enquiries.
6. **AC6 (projects and documents):** a `NOT_STARTED`, `IN_PROGRESS` or `ON_HOLD` project with `endDate` yesterday appears for its PM (an on-hold row shows its `holdReason`), one ending today does not, and `COMPLETED` or `CANCELLED` ones never do; an unassigned project appears for no one. Document rows equal `listDocumentsPendingReview` for the user, and a confirmed document drops out.
7. **AC7 (sections and dedupe):** the IST boundary: at 23:30 IST (18:00 UTC) a follow-up due "tomorrow" in IST is in Coming up, and one due that IST day is in Due today. A record with two reasons appears once, with the higher-priority kind, the earliest due date and the other in `alsoReasons`. Sorting is stable as specified. With 150 overdue rows, the section returns 100 and `counts.overdue = 150`.
8. **AC8 (RBAC):** a Sales user or PM asking for another user's My Today gets not found; an admin gets it, and the rows equal what that user sees for themselves; asking for an inactive or system user is not found. No row ever names a record the viewed user cannot read (a test re-reads every row's record as that user). `actions` omit **Mark paid** and **Log follow-up** when the viewer lacks the permission, and are only **Open** when an admin views someone else.
9. **AC9 (read-only):** `getMyToday` and `myTodayBadgeCount` write no audit rows and no records. `myTodayBadgeCount` equals `counts.overdue + counts.dueToday`.
10. **AC10 (settings):** `staleEnquiryDays` outside 1–365 is refused by the schema and the DB `CHECK`; updating it writes one `CompanySettings` audit row; non-admins cannot change it.
11. **AC11 (performance):** on the seed scaled ×10 (a test helper), `getMyToday` for the busiest user runs in under 300 ms locally, with no query per row (asserted by counting queries).

**End-to-end** (Playwright):

12. **AC12 (Sales flow):** a Sales user signs in, lands on My today, sees the nav badge count, logs a follow-up with a next date next week on a missed quotation follow-up, and sees the row leave Overdue and appear in Coming up with a toast.
13. **AC13 (PM flow):** a PM marks an overdue invoice paid from My today; the row collapses and the badge count drops. They open a document-to-review row and land on the review screen.
14. **AC14 (admin):** an admin switches **Viewing** to a Sales user and sees that user's rows with **Open** as the only action.

**Quality:**

15. **AC15:** `pnpm typecheck && pnpm lint && pnpm test` pass. `m11_my_today` applies after M10. UI guide checklist run on `/today`, including dark mode and 375 px width.

## Decisions

1. **My Today is about responsibility, not visibility.** Scope decides what a user _may_ see; My Today shows what is _theirs to act on_. An admin can read every invoice but their list shows only what they own or manage, otherwise it would be the whole company's receivables.
2. **Who owns a follow-up row.** Enquiry follow-ups go to the enquiry's owner, so reassigning an enquiry hands over its chasing (as quotations do through their owner). Client-level, project, PO and invoice follow-ups go to the follow-up's author, provided they can still read the record: those records have two people on them (PM and owner), and the one who promised the next call is the one to make it.
3. **Every row has one due date, and the date alone decides its section.** This keeps the three panels of UI guide 4.4 and a single sort. Kinds without a natural due date get one: a stale enquiry is due when it crossed the threshold, a document when its extraction finished, a late project on its planned end.
4. **One row per record.** An overdue invoice with a chase follow-up due is one job, not two rows. The priority order puts money first, then client-facing promises, then internal hygiene.
5. **"Stale" means nobody has planned the next step.** An `IN_PROGRESS` enquiry is stale when its last touch (received date or latest follow-up date) is older than `staleEnquiryDays` and no follow-up has a next date. A missed next date is already a `FOLLOW_UP_DUE` row, so it is not reported twice. The threshold is a company setting, not a constant, because sales cycles differ by sector; one value for the company is enough for v1. The default is 30 days (confirmed by the product owner). A stale row only says how long the enquiry has been quiet; it does not prompt the owner to mark it lost.
6. **Admins can view anyone's My Today, read-only.** Useful for covering an absent rep. Row actions are **Open** only, so an admin does not log follow-ups under their own name from someone else's list by accident; they act from the record page as usual.
7. **No pagination; 100 rows per section with exact counts.** A list longer than that is a backlog, not a day's work, and the list pages already filter and paginate it.
8. **Computed on read, no stored task table.** Every source already has the column and index it needs (M4–M10 added them for this module). A task table would need syncing from every write path and could drift, as PO status nearly did (M9 risk).
9. **My today replaces Home.** It is the page every role needs first; the Home tiles duplicate the list summary strips.
10. **Coming up is seven days,** matching M10's `next7` window so invoice counts agree with the invoice list.
11. **The daily email digest waits for M14** (confirmed by the product owner). It needs an email provider, per-user opt-out and deliverability work, and the in-app list should settle first. M14 builds it as a worker job on the existing `system` queue that calls `getMyToday` per active user and mails Overdue and Due today, so the digest and the page share one definition.
12. **Invoice rows go to both the project's PM and the pipeline owner** (confirmed by the product owner). Both can update the invoice and mark it paid (M10 Decision 14), so either may chase the payment. On an unassigned project, only the owner sees them.

## Dependencies

None new. Reuses `todayInIST`, the scope functions, `ACTIVE_QUOTATION_STATUSES`, `ACTIVE_PROJECT_STATUSES`, `dueWindowWhere`, `listDocumentsPendingReview`, the M5 follow-up registry `labels`/`visibleIds`, `recordHref`, and the `Panel`, `PageHeader`, `Money`, `FollowUpSheet` and `PaymentDialogs` components.

## Risks

- **Time zones.** Every comparison is on IST calendar days from `todayInIST()`, never `new Date()`. AC7 pins the 23:30 IST edge. The page must render `today` from the service result, not the browser clock.
- **"Latest follow-up per record" in SQL.** `DISTINCT ON (entityType, entityId) … ORDER BY date DESC, createdAt DESC` must match `getLatestFollowUp` exactly, or rows disagree with the quotation sync. A test compares the two over the seed.
- **Query cost.** Seven sources, some joining invoice → PO → project → quotation. Bound each in SQL by date and responsibility before merging; AC11 guards query count and time. The badge runs on every page load: cache it per request (React `cache`) and fall back to a cheaper count if measured slow.
- **Reassignment gaps.** A follow-up whose author left the company (deactivated user) or lost access has no one's row. M12 or an admin report should surface orphaned due follow-ups; noted for M12.
- **Seed drift.** The golden test depends on seed dates relative to today. Pin `today` in the test and build seed dates from the same `todayInIST` so the fixture holds on any day.

## Open questions

Settled by the product owner: the email digest is M14 (Decision 11); `staleEnquiryDays` defaults to 30 (Decision 5); overdue and due invoices show for both the project's PM and the pipeline owner (Decision 12).

None open.

## Implementation notes (decided during the build)

- **Where the code lives.** `services/my-today.service.ts` (sources, actions, `getMyToday`, `myTodayBadgeCount`), `services/my-today-merge.ts` (pure merging, sorting and sections, unit-tested), `services/enquiry-queries.ts` (`findStaleEnquiries`, shared with `listEnquiries({ stale })`) and `services/document-queries.ts` (the pending-review query for any user). The last two take a `Db` and a user, so they are not exported from the package: `services/index.ts` promises every export takes `ctx` first.
- **Latest follow-up per record** is one `DISTINCT ON` read in `$queryRaw`, ordered exactly like `getLatestFollowUp` (date, createdAt, id; all descending). An inner filter narrows it to records that have a follow-up due for this user (their own, or on an enquiry they own), which does not change which follow-up is latest. Days go in and out as `YYYY-MM-DD` strings (`::date`, `to_char`), so no time zone reaches the comparison.
- **Stale and missed never merge.** Decision 5 makes them exclusive (a missed next date means the enquiry is not stale), so the "stale enquiry with a missed follow-up" case in the seed shows as one `FOLLOW_UP_DUE` row with no `alsoReasons`. The merge case in the seed is the overdue invoice with a chase follow-up.
- **Row titles do not repeat the record number** ("Follow up on the enquiry"), since the record label is on the line below. Titles are built in core, so M13's MCP tool gets the same wording.
- **Actions.** `REVIEW` is offered on every document row in the user's own list: `listDocumentsPendingReview` already limits it to the uploader and the record's owner, and the review screen enforces update access. `MARK_PAID` is checked with `can(update)` on the invoice.
- **Admin Viewing.** A non-admin asking for another user's list gets `NotFoundError` (not Forbidden), like any record they cannot read (M4 Decision 7). Inactive, system and unknown users are not found.
- **Home.** `/` redirects to `/today`, and `safeNext` falls back to `/today`, so sign-in lands there in one hop. The old Home tiles are gone; their counts are on the list summary strips.
- **Page.** `?kind=` is parsed with `myTodayKindGroupSchema` and passed to `getMyToday`, which narrows the rows before the 100-row cap, so section counts stay exact; `counts.byKind` (the chips) and `counts.badge` describe the whole list. Contacts for the follow-up sheet are read once per client on the list. A row sits on one line from 1280px; below that its actions wrap under the text (at 768px, and at 1024px beside the sidebar, three buttons beside the text crushed or clipped it). Rows that are collapsing out are `inert`.
- **One computation per request.** `apps/web/lib/my-today.ts` wraps `getMyToday` in React `cache`, so the layout's badge and the `/today` page share it (checked: one computation per `/today` load; a chip adds one for the filtered rows).
- **`MarkPaidDialog`** moved to `components/invoices/PaymentDialogs.tsx` (shared by the invoice pages and My today), importing the invoice actions from the route, as `DocumentCard` does.
- **Seed.** `ensureMyTodaySamples` adds two stale enquiries (one never touched, one whose last call set no next step) and a follow-up on the paid invoice INV/26-27/0001. All three are re-added by whichever seed path recreates their parents, and the paid-invoice follow-up is added at most once.
- **AC11** is measured on a world with 30 records of each kind for one Sales user and PM, not on a copy of the seed ×10: the check that matters is that the query count is the same for 3 and 30 (no query per row). Queries are counted by running the service with a counting proxy as the store's client.
- **E2E.** The ⌘K test in `shell.spec.ts` now retries the shortcut until the palette opens: landing on `/today` after the redirect sometimes let the keypress arrive before hydration.
