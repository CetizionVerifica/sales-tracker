# M3 — Admin

Depends on: M0, M1, M2.

## Goal

Admins run the app from `/admin`:

- User management: create users, edit them, change roles, reset passwords, deactivate and reactivate.
- The master data every deal uses: clients (with contacts), sectors and services.
- The company settings.
- The audit log, through a viewer.

Non-admins cannot reach any of it. M3 also adds **soft delete** (CLAUDE.md rule 4), because clients, sectors and services are the first soft-deletable models, and it picks up the items carried over from M2.

## In scope

### Database (`packages/db`)

- **`Sector`** and **`Service`**:
  - `id`, `name`, `active Boolean @default(true)`, `createdAt`, `updatedAt`, `deletedAt DateTime?`.
  - `name` is unique **case-insensitively among non-deleted rows**. This uses a partial unique index on `lower(name) WHERE "deletedAt" IS NULL`, written in the migration's SQL because Prisma cannot express it.
- **`Client`**:
  - `id`, `name`, `sectorId` (FK to `Sector`, required), `gstin String?`, `address String?`, `notes String?`, `createdAt`, `updatedAt`, `deletedAt`.
  - `name` has the same case-insensitive partial unique index.
- **`ClientContact`**:
  - `id`, `clientId` (FK), `name`, `designation?`, `email?`, `phone?`, `isPrimary Boolean @default(false)`, timestamps, `deletedAt`.
  - At most one primary contact per client (partial unique index on `clientId WHERE "isPrimary" AND "deletedAt" IS NULL`).
- **`CompanySettings`** (one row):
  - `id Int @id @default(1)`, with a `CHECK (id = 1)` so a second row is impossible.
  - `companyName`, `defaultInvoiceDueDays Int @default(30)`, `enabledCurrencies String[] @default(["INR"])`, `baseCurrency String @default("INR")`, `updatedAt`.
- All new models are audited automatically; the M2 coverage test enforces this.
- Migration: `m3_admin_masters`.

### Soft delete (`packages/core/audit/` or `packages/core/soft-delete/`)

- A model with a `deletedAt` field is **soft-deletable**. The list comes from the same model metadata M2 uses.
- **Reads hide soft-deleted rows by default.** For `findMany`, `findFirst`, `findUnique`, `count`, `aggregate` and `groupBy` on those models, the extension adds `deletedAt: null`, unless the query's `where` already mentions `deletedAt` (explicit opt-in, e.g. `{ deletedAt: { not: null } }` for a "Deleted" filter).
- **Hard deletes throw** (`delete` and `deleteMany` on soft-deletable models). Services soft delete with an update that sets `deletedAt`, which M2's extension records as `SOFT_DELETE`. Clearing it is recorded as `RESTORE`. This fails closed, like M2.
- The audit extension's own before/after reads must still see soft-deleted rows. See Risks.

### Services (`packages/core/services/`)

Every function takes `ctx`, calls `assertCan` first, writes inside `withTx`, and validates input with a Zod schema from `packages/core/schemas`.

- **`user.service.ts`** (admin only unless noted):
  - `createUser`: name, email, role, and an initial password of at least 12 characters, set by the admin. There is no email in v1. It uses Better Auth's server-side admin API inside `withTx`, so the `User` and `Account` rows are audited.
  - `updateUser`: name, email (unique) and role.
  - `resetUserPassword`: an admin-set temporary password. It revokes all of that user's sessions. The `Account` update is audited, with the password redacted.
  - `reactivateUser`, alongside M1's `deactivateUser`.
  - `changeOwnPassword(ctx, { currentPassword, newPassword })` is **for any signed-in user**. It verifies the current password, sets the new one, and revokes the user's _other_ sessions. This replaces Better Auth's `/change-password` route, which M2 disabled.
  - **Guardrails:**
    - An admin cannot change their own role or deactivate themselves.
    - Nobody can demote or deactivate the **last active admin**.
    - The system user is never listed, edited or reset.
- **`sector.service.ts`** and **`service.service.ts`** (the same shape):
  - `list` (search, active/inactive/deleted filter, sort, paginate), `get`, `create`, `update` (name, active), `softDelete`, `restore`.
  - `listOptions` returns active, non-deleted rows for pickers (M4).
- **`client.service.ts`**:
  - `list` (search by name, filter by sector and deleted, sort, paginate), `get` (with contacts), `create`, `update`, `softDelete`, `restore`, `listOptions`.
  - Contacts: `addContact`, `updateContact`, `removeContact` (soft), `setPrimaryContact`. Each is a separate write inside `withTx`, because M2 rejects nested writes.
- **`settings.service.ts`**:
  - `getSettings(ctx)` for all roles.
  - `updateSettings(ctx, input)` for admins only:
    - `defaultInvoiceDueDays` is an integer from 0 to 365.
    - `enabledCurrencies` are valid ISO 4217 codes (checked against `Intl.supportedValuesOf('currency')`) and must include `INR`.
    - `baseCurrency` is fixed at `INR` and cannot be edited (CLAUDE.md).
- **Permissions:** everyone can read clients, sectors and services. Admins can write all of them, and `SALES` can also **create** clients (Decision 11). `client` becomes its own resource in `can()`, and `master` keeps sectors and services. Settings: everyone can read, only admins can update. Users: admin only. Audit log: listed with the M2 scope.

### Seed

- It always creates the `CompanySettings` row (company name "Sales Tracker" until an admin changes it).
- In development only, it adds a small set of sample sectors (e.g. Manufacturing, Pharma, Infrastructure) and services (e.g. Inspection, Certification, Audit).
- Every seed write goes through `withTx(systemCtx())`, so it is audited as the system user.

### Web (`apps/web`)

- An admin area with navigation: Users, Clients, Sectors, Services, Settings, Audit log. The M1 admin layout keeps rendering the Forbidden page for non-admins.
- **Lists:** TanStack Table with server-side pagination, sorting and filtering, driven by URL search params (CLAUDE.md conventions). Soft-deleted rows appear only under a "Deleted" filter, with a Restore action.
- **Forms:** React Hook Form with `zodResolver` and the shared schemas. Server actions go through M1's `action()` wrapper and return `{ ok, data } | { ok: false, error, fieldErrors }`. Duplicate names and emails show as field errors.
- **Users:**
  - A list with a role and status filter.
  - Create and edit dialogs.
  - Reset password, with the temporary password shown once to the admin.
  - Deactivate and reactivate, each behind a confirmation dialog.
- **Clients:**
  - A list, and create and edit forms with a sector picker. Inactive or deleted sectors are hidden from the picker but still shown on existing clients.
  - A contacts section: add, edit, remove, and mark as primary.
- **Settings:** a single form. Base currency is shown read-only.
- **Audit log:**
  - `/admin/audit-log` is a table with filters (entity type, entity id, actor, date range).
  - A detail panel shows the before and after, with the changed fields highlighted.
  - Times are shown in `Asia/Kolkata`.
- **`/activity`** (every signed-in user): the same viewer, scoped by M2 to the user's own changes (PLAN.md: "read own changes").
- **`/account/password`** (every signed-in user): the change-password form.
- Currency is formatted with `Intl.NumberFormat('en-IN', …)` wherever it is shown. Nothing money-related is edited in M3.

## Out of scope

- Enquiries and anything that references clients beyond the masters themselves: M4.
- The per-client timeline: M5.
- Bulk import of masters from CSV or Excel: M13.
- Email (invites, reset links), two-factor auth, avatars: not planned for v1.
- Sign-in event logging (`AuthEvent`): M14.
- Hard deletion of anything: never (rule 4).

## Acceptance criteria

**Users** (integration, plus an E2E flow):

1. **AC1:** an admin creates a user. The new user can sign in. The audit log has `User` and `Account` `CREATE` rows with `source: 'web'`, and no password hash. A duplicate email returns a field error.
2. **AC2:** an admin edits a user's name, email and role, producing an `UPDATE` row with the right `changedFields`.
3. **AC3:** an admin resets a password:
   - The old password stops working and the new one works.
   - The user's existing sessions are revoked.
   - The `Account` `UPDATE` row lists `password` in `changedFields` and never stores the hash.
4. **AC4:** reactivating a deactivated user lets them sign in again.
5. **AC5 (guardrails):**
   - Changing your own role is rejected, and so is deactivating yourself.
   - Demoting or deactivating the last active admin is rejected.
   - The system user cannot be listed, edited, reset or deactivated.
6. **AC6:** a signed-in user changes their own password. A wrong current password is rejected. On success their other sessions are revoked and the change is audited.
7. **AC7:** every user-management service throws `ForbiddenError` for `SALES` and `PROJECT_MANAGER`, and the matching server actions return the forbidden result.

**Masters and soft delete:**

8. **AC8:** sectors and services support create, rename, activate/deactivate, soft delete and restore.
   - Names are unique case-insensitively among non-deleted rows: "pharma" is rejected while "Pharma" exists, and allowed again once it is deleted.
   - The audit rows are `CREATE`, `UPDATE`, `SOFT_DELETE` and `RESTORE`. This is the **M2 carry-over integration test**.
9. **AC9 (soft-delete extension):**
   - Soft-deleted rows are excluded by default from `findMany`, `findFirst`, `findUnique` and `count`.
   - A `where` that mentions `deletedAt` opts in.
   - `delete` and `deleteMany` on a soft-deletable model throw.
   - The audit extension still records before/after for soft deletes and restores.
10. **AC10:** clients support create, update, soft delete and restore, with a sector. List search, sector filter, sort and pagination work. An invalid GSTIN is rejected; the field is optional.
11. **AC11:** contacts can be added, edited and removed. Only one contact is primary: setting a new primary unsets the old one, in one `withTx`.
12. **AC12:** `listOptions` returns only active, non-deleted rows. `get` on a client whose sector was deactivated or deleted still returns that sector's name.
13. **AC13:** all roles can list and read masters. Only admins can create, update, delete or restore them, except that `SALES` can create clients (and add contacts while creating them). Sales still cannot edit, delete or restore clients, and project managers cannot create them. Each service has success and permission-denial tests.

**Settings:**

14. **AC14:**
    - Every role can read the settings.
    - Only admins can update them, and each update is audited.
    - Invalid due days or currency codes are rejected, as is a currency list without `INR`.
    - `baseCurrency` cannot be changed.
    - A second settings row cannot be inserted, even with raw SQL (the `CHECK` constraint).

**Audit viewer:**

15. **AC15:** an admin sees every audit row at `/admin/audit-log`, with working filters and pagination. The detail view shows before and after with the changed fields marked. Times are in IST.
16. **AC16:** a non-admin's `/activity` shows only their own changes.

**End-to-end (Playwright):**

17. **AC17:** the admin:
    - creates a sales user, then signs out;
    - (as the sales user) signs in, then signs out;
    - signs back in, changes that user's role to project manager, and resets their password;
    - sees these changes in the audit log.
18. **AC18:** the admin creates a sector and a client with a primary contact. A sales user gets the Forbidden page on `/admin/clients`.

**Quality:**

19. **AC19:** `pnpm typecheck && pnpm lint && pnpm test` pass, the `m3_admin_masters` migration applies to an empty database, and every new model passes the M2 audit coverage test.

## Decisions

1. **Two different "off" states for masters.**
   - `active = false` retires a sector or service: it is hidden from pickers, but existing records keep showing it.
   - `deletedAt` is for mistakes and duplicates: the row disappears from lists (except under the "Deleted" filter).
   - Clients have no `active` flag, only soft delete (PLAN.md).
2. **Hard deletes on soft-deletable models throw** instead of being silently turned into soft deletes. This is explicit and fails closed, like M2.
3. **Soft-delete filtering is automatic, with explicit opt-in** by mentioning `deletedAt` in `where`. There is no hidden flag.
4. **Uniqueness uses partial indexes in migration SQL,** so a deleted "Pharma" does not block creating a new one.
5. **Passwords:** admins set the initial and reset passwords, because there is no email in v1. Users change their own password through an audited core service. Resetting a password revokes that user's sessions.
6. **Last-admin protection** keeps the company from locking itself out.
7. **One settings row,** enforced by `id = 1` plus a `CHECK` constraint. The base currency is fixed at INR.
8. **Contacts are their own model** (not JSON), so they are audited field by field, and M5 and M13 can reference them.
9. **GSTIN is optional but validated** (15-character format). M10 will use it for the invoice-client mismatch warning.
10. **The audit viewer is shared:** admins get `/admin/audit-log`; everyone gets `/activity` for their own changes. It is the same component with M2's scoping.
11. **Sales can create clients** (confirmed by the product owner), so a rep logging an enquiry for a new company (M4) is not blocked.
    - Sales cannot edit, delete or restore clients; admins keep control of cleanup. Sectors and services stay admin-only.
    - This needs a separate `client` resource in `can()`: it moves out of `master`, and the policy table and its tests change to match.
    - Project managers cannot create clients.

## Dependencies

| Package                                                                                                                                 | Where | Why                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tanstack/react-table` **8.21.3**                                                                                                      | web   | Server-side data tables (CLAUDE.md stack). Pinned to 8.x: 9.x is a new major version with a redesigned options API (features, reactivity bindings). Upgrading is a separate change. |
| `sonner`                                                                                                                                | web   | Toasts for save, delete and restore results (shadcn's toast component).                                                                                                             |
| `lucide-react`                                                                                                                          | web   | Icons used by the shadcn components (select, dialog, sort arrows).                                                                                                                  |
| shadcn/ui components (`table`, `dialog`, `alert-dialog`, `select`, `badge`, `dropdown-menu`, `sheet`, `textarea`, `checkbox`, `sonner`) | web   | Admin UI. Copied into `components/ui`, and use `radix-ui`, which is already installed.                                                                                              |

The shadcn CLI again added its own `cn` package, plus `next-themes` for the toast theme. Both were removed: the components use the existing `@/lib/utils` `cn()`, and the toaster uses a fixed light theme.

Time-zone display uses `Intl.DateTimeFormat` with `timeZone: 'Asia/Kolkata'`, so no date library is needed.

## Risks (resolved during planning and build)

- **Order of the soft-delete and audit extensions:**
  - The audit extension re-reads rows by `id` after a write. With the soft-delete filter applied, the re-read after a _soft delete_ would find nothing, and `findUniqueOrThrow` would fail.
  - Planning must settle the order, or have the audit reads opt in (for example `where: { id, deletedAt: undefined }` counts as "mentions `deletedAt`"). A test has to prove soft-delete and restore rows are recorded.
- **Better Auth server APIs inside `withTx`:** confirm that `setUserPassword` (reset) and a password check against the stored hash (for `changeOwnPassword`) run on the transaction client, as `createUser` did in M2. Fallback: hash with Better Auth's password hasher and update `Account` directly inside `withTx`.
- **Partial unique indexes and Prisma errors:** a duplicate-name violation surfaces as a Prisma `P2002` error without the field names Prisma usually gives. The services should check for an existing name first (inside the transaction) for friendly field errors, with the index as the final guard.
- **Server-side TanStack Table with the App Router:** the table state has to live in URL search params, read by a server component that calls core services. Confirm this pattern early, since M4–M12 will reuse it.

## Implementation notes (decided during the build)

- **Passwords:** the admin plugin's `setUserPassword` requires an admin _session_, so it cannot be called from the server. `auth/passwords.ts` uses Better Auth's internal `password.hash`, `password.verify` and `internalAdapter.updatePassword` instead. The planning spike showed they run on the `withTx` transaction: a rollback undoes them, and a commit writes an audited `Account` update with the hash redacted.
- **Soft delete lives in the same query hook as auditing.** The audit extension's own reads add `deletedAt: undefined`. Prisma ignores it, but it counts as "mentions `deletedAt`", so audit before/after reads see soft-deleted rows. Relations loaded with `include` are not filtered; services filter them explicitly (tested).
- **`changeOwnPassword` keeps the current session.** `Ctx` gained an optional `sessionId`, set by `getCtxFromHeaders`.
- **Creating a client from the admin UI** saves the client first, then opens its page to add contacts. The service still accepts initial contacts, which the M4 enquiry form will use.
- **`AUTH_SIGNIN_RATE_LIMIT`** (default 5 per minute) makes the sign-in limit configurable. Only the E2E server raises it, because every test signs in from `127.0.0.1`.

## Bugs found while building M3 (fixed)

- **M2's audit extension stored `entityId` as the raw id.** `CompanySettings.id` is an `Int`, so the audit insert failed. Ids are now stored as text.
- **`packages/core` is loaded twice inside Next.js** (server actions and server components are separate bundle layers).
  - The Prisma client, cached on `globalThis`, read one module copy's `AsyncLocalStorage` while `withTx` wrote to the other's, so every audited write from a server action failed with `AuditContextError`.
  - The async storage and the model metadata are now process-wide singletons on `globalThis`.
  - A regression test loads the store module twice. It fails with the old code.
- **Table cells remounted on every refresh,** because TanStack's `flexRender` treats inline cell renderers as components, which closed open dialogs (e.g. the reset-password result). Column definitions are now memoised.

## For M14 (hardening)

- **Client IP trust:** without `TRUSTED_PROXY_CIDRS`, Better Auth trusts a _single-value_ `x-forwarded-for`. If the app were reachable without a proxy that overwrites that header, a client could fake it and dodge the sign-in rate limit. Production must sit behind a proxy that sets `x-forwarded-for`, with `TRUSTED_PROXY_CIDRS` configured.
- **TanStack Table 9 upgrade**, if its API has settled.

## Open questions

None. Client creation by Sales was settled as Decision 11.
