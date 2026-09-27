# M5 — Follow-ups and timeline

Depends on: M0, M1, M2, M3, M4.

## Goal

Sales reps and project managers record every touchpoint with a client (a call, an email, a meeting, a site visit) and when the next one is due. Each client gets one **timeline** that mixes those follow-ups with the pipeline's status changes and, from M7, its documents, newest first.

- Log, edit and delete follow-ups on a client or on any pipeline record that belongs to one. In M5 that is the client itself and its enquiries; M6–M10 plug in quotations, projects, POs and invoices.
- A per-client timeline: follow-ups, record creation and status changes (read from the M2 audit log), in date order.
- A per-record timeline (e.g. on the enquiry page) filtered to one record.
- A small contract that M6 (quotation next follow-up date and highlights) and M11 (follow-ups due or missed) build on.

PLAN.md "done when": the timeline shows mixed events in date order.

## In scope

### Database (`packages/db`)

- **`FollowUpChannel`** enum: `CALL`, `EMAIL`, `MEETING`, `SITE_VISIT`, `WHATSAPP`, `OTHER`.
- **`FollowUpEntityType`** enum: `CLIENT`, `ENQUIRY`, `QUOTATION`, `PROJECT`, `PURCHASE_ORDER`, `INVOICE`. All six exist now so later modules need no enum migration; the service accepts only the types whose module has shipped (Decision 3).
- **`FollowUp`**:
  - `id`, `clientId` (FK `Client`), `userId` (FK `User`, the author).
  - `entityType FollowUpEntityType`, `entityId String`. For `CLIENT`, `entityId = clientId`. Polymorphic, so no FK on `entityId`; the service checks it (Decision 2).
  - `contactId String?` (FK `ClientContact`): who at the client was spoken to. Must belong to `clientId`.
  - `date DateTime @db.Date`: when the touchpoint happened. Not in the future.
  - `channel FollowUpChannel`.
  - `notes String`: what was discussed, 1–4000 chars.
  - `nextFollowUpDate DateTime? @db.Date`: on or after `date`.
  - `createdAt`, `updatedAt`, `deletedAt DateTime?` (soft-deletable).
  - Indexes: `(clientId, date)`, `(entityType, entityId, date)`, `(userId, nextFollowUpDate)` (the last for M11).
- `CHECK ("nextFollowUpDate" IS NULL OR "nextFollowUpDate" >= "date")` in the migration SQL.
- `CHECK ("entityType" <> 'CLIENT' OR "entityId" = "clientId")` in the migration SQL.
- Back-relations on `Client`, `ClientContact` and `User`.
- Audited automatically; the M2 coverage test must pass.
- Migration: `m5_follow_ups`.

### RBAC (`packages/core/rbac`)

The M1 rule (`followUp`: CRUD when `userId === user.id`) covers editing and deleting. Creating and reading also depend on the record the follow-up is linked to, so M5 extends the instance (Decision 4):

- `ResourceInstance` for `followUp` becomes `{ type: 'followUp'; userId: string; canReadLinked: boolean }`.
- Rules for non-admins:
  - `create`: allowed when the actor may **read** the linked record. Checked in the service with the linked record's own `can()` instance, then `assertCan(ctx, 'create', …)`.
  - `read` / `list`: author, or anyone who may read the linked record (`canReadLinked`).
  - `update` / `delete`: author only. Admins may do everything.
- **`scopeFollowUps(user)`** in `rbac/scope.ts`:
  - `ADMIN`: `{}`.
  - Others: `OR` of `{ userId: user.id }`, `{ entityType: 'CLIENT' }` (client-level notes are visible to everyone who can read the client, which is everyone, per M3 Decision 11), and `{ entityType: 'ENQUIRY', entityId: { in: <ids from scopeEnquiries> } }` expressed as a subquery-friendly filter. Each later module adds its entity type here.
- A single helper `followUpResource(row, canReadLinked)` builds the instance.
- A `linkedEntity` registry in core (`packages/core/services/follow-up-targets.ts`) maps each supported `FollowUpEntityType` to: how to load the record's `clientId` and `can()` instance, its scope filter, and a display label (e.g. the enquiry number). M6–M10 each add one entry. This is the only place later modules touch.

### Schemas (`packages/core/schemas/follow-up.ts`)

- `createFollowUpSchema`: `entityType`, `entityId`, `date`, `channel`, `notes`, `contactId?`, `nextFollowUpDate?`. **No `clientId`**: it is derived from the linked record so it can't disagree with it.
- `updateFollowUpSchema`: `date`, `channel`, `notes`, `contactId`, `nextFollowUpDate`, all optional. The link (`entityType`, `entityId`) cannot change; delete and re-log instead. Empty string clears optional fields (M3 convention).
- `listFollowUpsSchema`: `listParamsSchema` plus `clientId`, `entityType`, `entityId`, `userId`, `channel[]`, `dateFrom/To`, `nextFrom/To`, `recordStatus`. Sortable: `date` (default, desc), `nextFollowUpDate`, `createdAt`.
- `clientTimelineSchema`: `{ clientId, entityType?, entityId?, kinds?: TimelineKind[], cursor?, limit (1–100, default 50) }`.
- Dates use M4's `calendarDateSchema`. `date` is not in the future (today in `Asia/Kolkata`); `nextFollowUpDate ≥ date`. `nextFollowUpDate` may be in the past only on edit when unchanged (a historical record), not when newly set.

### Services

**`packages/core/services/follow-up.service.ts`** — each function takes `ctx`, validates, calls `assertCan`, and writes inside `withTx`.

- `logFollowUp(ctx, input)`:
  - Loads the linked record through the registry. Missing, soft-deleted or not readable → `NotFoundError` (M4 Decision 7).
  - Unsupported `entityType` (module not built yet) → `DomainError` on `entityType`.
  - Sets `clientId` from the record, `userId = ctx.user.id`.
  - `contactId`, if given, must be a live contact of that client.
  - Returns the follow-up with author, contact and linked-record label.
- `updateFollowUp(ctx, id, input)`: author or admin. Same contact and date checks on the merged values.
- `softDeleteFollowUp` / `restoreFollowUp`: author or admin.
- `listFollowUps(ctx, input)`: `scopeFollowUps` ANDed with filters; `Page<FollowUpRow>`.
- `getFollowUp(ctx, id)`: not visible → `NotFoundError`.
- `getLatestFollowUp(ctx, entityType, entityId)`: the newest live follow-up on one record (by `date`, then `createdAt`). This is M6's source for `lastFollowUpHighlights` and the suggested `nextFollowUpDate` (Decision 6).
- Logging a follow-up on a soft-deleted client or record is rejected. Existing follow-ups stay when the record is later deleted (they keep appearing on the client timeline, labelled "deleted").

**`packages/core/services/timeline.service.ts`**

- `getClientTimeline(ctx, input)`:
  - `assertCan(ctx, 'read', 'client')`; client must exist (deleted clients: admins only).
  - Returns `{ items: TimelineEvent[], nextCursor: string | null }`.
  - Event kinds (`TimelineKind`):
    - `FOLLOW_UP`: from `FollowUp`, filtered by `scopeFollowUps`.
    - `CREATED`: an `AuditLog` `CREATE` row for a linked record (enquiry in M5).
    - `STATUS_CHANGE`: an `AuditLog` `UPDATE` row for a linked record whose `changedFields` include `status`, showing `before.status → after.status` (plus `lostReason` when present).
    - `DELETED` / `RESTORED`: `SOFT_DELETE` / `RESTORE` rows for linked records.
    - `DOCUMENT`: reserved; M7 adds the source.
  - Audit-derived events are filtered by **record visibility**, not by `scopeAuditLog` (Decision 5): the service first resolves the ids of linked records the actor can read (per registry scope), then reads audit rows for those ids. A Sales user therefore sees an admin converting their enquiry, but nothing about another rep's enquiries for the same client.
  - Each event: `{ id, kind, at, day, actor: { id, name }, entity: { type, id, label, deleted }, summary, followUp? }`, where `day` is the calendar day in `Asia/Kolkata`.
  - **Ordering (the "done when"):** by `day` desc, then `at` desc, then `id`. A follow-up's `day` is its `date` and its `at` is its `createdAt`, so a follow-up back-dated to Monday sorts on Monday among that day's status changes.
  - **Pagination:** keyset cursor over `(day, at, kind, id)`, opaque base64. Each source is queried for `limit + 1` rows before the cursor, merged in memory, and cut to `limit`. No offset pagination (sources are merged).
  - Optional `entityType` + `entityId` narrow to one record (used by the enquiry page); `kinds` narrows event types.
- The service never writes and never returns raw `before`/`after` JSON; only whitelisted fields go into `summary`.

### Seed

- Development only: 2–4 follow-ups on most sample enquiries and one or two client-level notes per sample client, across all channels, some with a `nextFollowUpDate` in the past (missed, for M11), today, and the future. Written through `logFollowUp` under `systemCtx()`, in the same all-or-nothing transaction as M4's sample pipeline.
- The system user is the author of seeded rows; where the sample should look realistic (the E2E fixtures), seed as the owning sales user's ctx with `source: 'system'`.

### Web (`apps/web`)

- **Clients for everyone.** Today clients live under `/admin/clients` (admin only). M5 adds a read-only **`/clients`** list (search by name, filter by sector) and **`/clients/[id]`** page for all signed-in users, since everyone may read clients. Admin editing stays under `/admin`; the admin client page links to `/clients/[id]` for the timeline. Main nav gets **Clients**.
- **`/clients/[id]`**:
  - Header: client name, sector, GSTIN, primary contact.
  - Tabs or sections: **Timeline** (default), **Enquiries** (the M4 list filtered to this client, respecting scope), **Contacts** (read-only for non-admins).
  - Timeline: a vertical list grouped by day (IST), each event with an icon per kind, actor, time, linked-record label (links to the record), and for follow-ups the channel, contact, notes and next follow-up date. Filters: kind (multi), record type. "Load more" uses the cursor.
  - **Log follow-up** button opens a dialog. On the client page the link defaults to the client itself, with a picker to attach it to one of the client's records the user can read.
- **Follow-up dialog** (shared component): record (fixed when opened from a record page), date (default today), channel, contact (the client's live contacts), notes, next follow-up date (quick picks: +3 days, +1 week, +2 weeks). React Hook Form + `zodResolver` with the core schema; server actions via M1's `action()`.
- **Edit / delete** from the timeline for the author and admins (confirmation on delete).
- **`/enquiries/[id]`**: replace M4's History panel with the record timeline (`getClientTimeline` narrowed to the enquiry) and add **Log follow-up**. Show the latest follow-up's next date near the status.

## Out of scope

- Quotation `nextFollowUpDate` and `lastFollowUpHighlights` fields, and keeping them in sync: M6 (it reads `getLatestFollowUp`; see Decision 6).
- Follow-ups on quotations, projects, POs and invoices: each module adds its registry entry (M6, M8, M9, M10).
- Document events on the timeline: M7.
- Reminders (email or in-app) for due follow-ups, the My Today view, and any "my follow-ups due / overdue" list: M11 (Decision 9). M5 only adds the `(userId, nextFollowUpDate)` index it will query.
- Calendar integration, email logging from a mailbox, and attachments on follow-ups: not planned.
- MCP tools `log_follow_up` and `get_client_timeline`: M13 (they call these services).

## Acceptance criteria

**Service and data** (integration tests against the test database):

1. **AC1:** a Sales user logs a follow-up on their own enquiry with a date, channel, contact, notes and next follow-up date. It is stored with `clientId` = the enquiry's client and `userId` = them; the audit log has one `FollowUp CREATE` with `source: 'web'`.
2. **AC2 (validation):** rejected with field errors:
   - a future `date`;
   - `nextFollowUpDate` before `date`;
   - empty notes, or notes over 4000 chars;
   - a contact from another client, or a deleted contact;
   - an `entityType` whose module hasn't shipped (e.g. `QUOTATION` in M5);
   - an `entityId` that doesn't exist, is soft deleted, or whose client is soft deleted.
   - The DB `CHECK`s reject `nextFollowUpDate < date` and a `CLIENT` follow-up whose `entityId ≠ clientId` even via raw SQL.
3. **AC3 (RBAC, write):**
   - A Sales user cannot log a follow-up on another rep's enquiry (not found).
   - Anyone may log a client-level follow-up.
   - Only the author or an admin can edit or delete a follow-up; another user gets not found (if they can't read it) or forbidden (if they can).
   - Each service function has happy-path, permission-denial and audit-row tests.
4. **AC4 (RBAC, read):** `listFollowUps` for Sales returns their own, client-level ones, and those on enquiries they own (including ones an admin logged); never follow-ups on another rep's enquiry. Admins see all. Project managers see their own and client-level ones (enquiry access pinned until M8).
5. **AC5:** updating a follow-up writes one `UPDATE` row with the right `changedFields`; the link cannot be changed. Soft delete and restore write `SOFT_DELETE` / `RESTORE`; deleted follow-ups drop out of lists and the timeline.
6. **AC6 (timeline, the "done when"):** for a client with, over three days, an enquiry created, two follow-ups (one back-dated to the first day), a conversion and a client-level note, `getClientTimeline` returns all five events in `(day desc, at desc)` order, with correct kinds, actors, labels and status `from → to`.
7. **AC7 (timeline visibility):** a Sales user's timeline for a client shared with another rep shows only their own enquiries' events, their own and client-level follow-ups, and the admin's status change on their enquiry. It never shows the other rep's enquiry creation or follow-ups. Admins see everything.
8. **AC8 (timeline pagination):** with 120 events and `limit: 50`, three pages return every event exactly once in order, including when several events share the same `day` and `at`. Narrowing by `entityType`/`entityId` and by `kinds` works.
9. **AC9:** `getLatestFollowUp` returns the newest live follow-up by `date` then `createdAt`, ignores deleted ones, and applies read RBAC.
10. **AC10 (list):** each filter (client, record, author, channel, both date ranges) narrows correctly; sort and pagination work; filters combine with the RBAC scope.
11. **AC11:** a follow-up on an enquiry that is later soft deleted still appears on the client timeline, marked deleted, for users who could read the enquiry.

**End-to-end (Playwright):**

12. **AC12:** a Sales user opens a client from **Clients**, logs a client-level call, opens one of their enquiries, logs an email follow-up with a next date, converts the enquiry, returns to the client page, and sees the call, the email, the creation and the conversion in date order.
13. **AC13:** a second Sales user opens the same client and sees the client-level call but none of the first user's enquiry events. An admin sees all of them.

**Quality:**

14. **AC14:** `pnpm typecheck && pnpm lint && pnpm test` pass, `m5_follow_ups` applies to an empty database, and `FollowUp` passes the M2 audit coverage test.

## Decisions

1. **A follow-up records a touchpoint that happened**, not a task. The next action is the `nextFollowUpDate` on it. "Done" is implicit: a follow-up's next date is superseded when a newer follow-up is logged on the same record. M11 treats only the latest follow-up per record as open.
2. **Polymorphic link (`entityType` + `entityId`), as CLAUDE.md specifies,** plus a required `clientId` for the per-client timeline. No FK on `entityId`, so the service validates it through the registry. The alternative (one nullable FK per entity type) gives referential integrity but means a migration and a CHECK rewrite in every later module.
3. **All entity types in the enum now; the registry gates them.** An enum migration per module would be churn; an unsupported type fails validation until its module adds the registry entry and tests.
4. **Visibility follows the linked record** (confirmed by the product owner). PLAN.md says follow-ups are "own" for Sales and PMs. Read literally, a rep couldn't see the follow-up an admin or PM logged on their enquiry, which breaks the timeline. So: read = author, or anyone who can read the record; edit/delete = author or admin. Client-level notes are readable by everyone.
5. **Timeline status events come from the audit log, filtered by record visibility.** No separate event table: M2 already stores every change with `changedFields`, and M2 Decision 6 anticipated this. `scopeAuditLog` (own changes only) is right for the audit viewer but wrong here, so the timeline service applies record scope instead and exposes only whitelisted fields.
6. **Quotation highlights are derived, not copied, in M5.** M6 decides whether `Quotation.lastFollowUpHighlights` and `nextFollowUpDate` are stored columns updated by `logFollowUp` (needed for M6's "next follow-up required" rule and fast M11 queries) or computed from `getLatestFollowUp`. M5 provides `getLatestFollowUp` and a hook point in `logFollowUp` (a per-type `afterLog` in the registry) so M6 can sync in the same transaction.
7. **Follow-up date is a calendar day, not a timestamp.** Reps log calls after the fact; a day is what they know. Ordering within a day uses `createdAt`.
8. **A read-only `/clients` area for all users.** The timeline is per client and every role may read clients, so it can't live under `/admin`.
9. **No `/follow-ups` list in M5** (confirmed by the product owner). Due and overdue follow-ups belong in M11's My Today view.
10. **Logging needs read access to the record, not update** (confirmed by the product owner). From M8, a PM can log a follow-up on a quotation they can only read; the follow-up is theirs to edit, the quotation is not.
11. **Channels** (confirmed by the product owner): `CALL`, `EMAIL`, `MEETING`, `SITE_VISIT`, `WHATSAPP`, `OTHER`. An enum, not a master table, for the same reason as M4's enquiry source.

## Dependencies

None new. Reuses the M3/M4 table, dialog, badge and toast components and `calendarDateSchema`. Timeline icons come from `lucide-react`, already used by shadcn.

## Risks

- **Scope filters for polymorphic rows.** Prisma can't join on `entityId`; `scopeFollowUps` needs `entityId in (select id from enquiry where …)`. For M5 volumes, resolving visible ids first is fine; if it grows (M8 adds PM scoping through projects), switch to a SQL view or `$queryRaw` read, still inside core. Measure on the seed.
- **Audit JSON reads.** Status events read `before->>'status'` and `after->>'status'`. Filter with `changedFields has 'status'` (indexed by the existing `(entityType, entityId, createdAt)`), and only then parse JSON in TypeScript.
- **Merging sources with a keyset cursor.** Ties on `(day, at)` across sources must be broken deterministically (`kind`, then `id`), or events repeat or vanish between pages. AC8 guards this.
- **Day boundaries.** An audit row created at 00:30 IST belongs to that IST day, not the UTC day before. Compute `day` in `Asia/Kolkata` and test around midnight.
- **Replacing the M4 History panel.** The M4 E2E test may assert on it; update the test, not the behaviour it checks (field changes by the owner stay visible under the audit log viewer at `/activity`).
- **Deleted records' labels.** Audit rows outlive soft-deleted enquiries; label lookups must include deleted rows (`recordStatus: 'all'` style read) or events render without a label.

## Open questions

Settled by the product owner: visibility follows the linked record and client-level notes are visible to all (Decision 4), logging needs read access (Decision 10), the channel list (Decision 11), and no `/follow-ups` list until M11 (Decision 9).

None remaining.

## Implementation notes (decided during the build)

- **`scopeFollowUps(user, visible)` takes the readable record ids.** `entityId` has no relation Prisma can join on, so the services resolve readable ids per type first (`visibleRecordIds` in `follow-up-targets.ts`) and pass them in. This keeps `scopeFollowUps` a pure filter like the other scope functions. Admins skip the lookup.
- **Policy shape.** `followUp` is now: `list` always (rows are scoped); `create` needs `userId === actor` and `canReadLinked`; `read` needs author or `canReadLinked`; `update`/`delete` need the author. Admins pass everything in `can()`.
- **No "next date not newly in the past" rule.** The spec's Schemas section said a newly set `nextFollowUpDate` may not be in the past. It was dropped: it blocks back-filling a call from last week whose next date has also passed, M13 history imports, and the seed's missed follow-ups for M11. The rules are `date ≤ today (IST)` and `nextFollowUpDate ≥ date` (Zod, service on merged values, and DB `CHECK`).
- **Timeline ordering and paging.** Events sort by `(day desc, at desc, rank, id)`, where `rank` separates follow-ups (0) from audit rows (1).
  - Each source is queried in its own database order and the two lists are **merged** rather than re-sorted in JavaScript. Postgres' text collation for `id` can differ from JS string order, so re-sorting ties could move the page cut, and events would repeat or vanish.
  - The audit cursor bounds by IST day first (`createdAt < start of cursor day`), then by `at` within the day. A back-dated follow-up's `at` lies after its day, and a plain `createdAt < at` would re-emit later-day audit rows. AC8 fails with that naive cursor (checked).
- **Cursor parsing is idempotent.** `clientTimelineSchema.cursor` accepts the opaque string or an already-decoded cursor, so a server action's parse followed by the service's parse works (the same idea as `calendarDateSchema`). Encoding uses `btoa`/`atob`, not `Buffer`, because schemas are also bundled for the browser.
- **Timeline record filter.** The client page filters by one record (`?record=ENQUIRY:<id>`, or the client only), matching the schema's `entityType` + `entityId`, rather than by record type. With one audited type in M5 the two are nearly the same; revisit when M6 adds quotations.
- **`listFollowUps` also searches notes (`q`).** It costs nothing and M11/M13 will want it.
- **Seed.** Sample follow-ups (all six channels; next dates missed, due today and upcoming) are logged as the enquiry owners with `source: 'system'`. They are added when no follow-ups exist, even if enquiries do, so a database seeded before M5 gets them on the next `pnpm db:seed`. They attach to sample enquiries by (client, owner, source), which is unique among the eight.
- **History panel replaced.** `EnquiryHistory` is gone; the enquiry page shows its timeline, a **Log follow-up** button and the latest next follow-up date. The M4 E2E assertion on the History panel ("Updated … owner") now checks the admin's `/activity` page, where field edits still appear.
- **Shared list helper.** `multi()` (comma-separated enum lists) moved from `schemas/enquiry.ts` to `schemas/list-params.ts`.

## Code review fixes

- **Concurrent edit, delete and restore.** These read the follow-up and then wrote it by `id` alone, so two requests at once could both succeed: a follow-up edited after it was deleted, or deleted twice (two audit rows). The writes are now conditional `updateMany` calls that re-check `deletedAt` (live for edit and delete, deleted for restore). A request that loses the race updates nothing and fails with "Someone else changed this follow-up". The merged-date rule is also backed by the DB `CHECK`, so a concurrent date edit cannot slip through.
  - The tests race delete against delete and edit against delete, 10 rounds each. Both failed before the fix. The losing request is refused either at the guarded write or, if the winner committed first, at the read (not found); both count as a correct refusal.
- **Test gaps closed:** restore by a non-author is forbidden; the record picker returns not found for a deleted client; switching to another client's contact on edit is rejected.

## For M6 (quotations)

- Add a `QUOTATION` entry to `FOLLOW_UP_TARGETS` (`load`, `visibleIds`, `labels`, `pickable`, `auditModel: 'Quotation'`), add its ids to `scopeFollowUps`/`visibleRecordIds`, and add `recordHref` in `apps/web/lib/follow-up-labels.ts`.
- Use the target's `afterLog` hook to update the quotation's `nextFollowUpDate` and `lastFollowUpHighlights` in the logging transaction, or read `getLatestFollowUp` (Decision 6).
