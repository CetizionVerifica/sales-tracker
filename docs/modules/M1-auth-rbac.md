# M1 — Auth and RBAC

Depends on: M0.

## Goal

People sign in with email and password, sessions persist, and every request knows who is acting. A single `can(user, action, resource)` function in `packages/core` decides every permission, following the role matrix in PLAN.md. Services, server actions, routes and pages are guarded by it. An admin user is seeded. There is no user-management UI yet (that is M3), and no domain entities (enquiries start in M4).

## In scope

### Database (`packages/db`)

- A `Role` enum: `ADMIN`, `SALES`, `PROJECT_MANAGER`.
- Better Auth tables, generated with the Better Auth CLI and then adjusted:
  - `User`: `id`, `name`, `email` (unique), `emailVerified`, `image?`, `role Role @default(SALES)`, `active Boolean @default(true)`, `isSystem Boolean @default(false)`, `createdAt`, `updatedAt`.
  - `Session`, `Account` (holds the password hash), `Verification`.
  - The admin plugin's extra fields (`banned`, `banReason`, `banExpires` on `User`; `impersonatedBy` on `Session`). The plugin requires them; they stay unused.
- Users are never deleted, only deactivated (`active = false`). This is how rule 4 (soft delete) applies to users, so `User` has no `deletedAt`. Session, Account and Verification rows are auth plumbing and may be hard-deleted by Better Auth.
- Migration name: `m1_auth`.
- Seed: see "Seed" below.

### Auth (`packages/core/auth/`)

- The Better Auth instance is configured in `packages/core`, using core's Prisma client. Apps import it from core. That keeps every database write inside `packages/core` (rule 1), and lets M2's audit extension see auth writes.
- Sign-in is by email and password only:
  - `disableSignUp: true`. Only admins create users (the service is below; the UI is M3).
  - Minimum password length is 12.
  - No email verification and no self-service password reset in v1. Admins reset passwords in M3.
- Admin plugin, configured with the `Role` values: `defaultRole: 'SALES'`, `adminRoles: ['ADMIN']`.
- Sessions:
  - They last 7 days, sliding (the expiry refreshes daily while in use).
  - Cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
- Better Auth's built-in rate limiting is on: 5 sign-in attempts per minute per IP. The login form posts to Better Auth's endpoint (not a server action) so this limit applies.
- The admin plugin's HTTP routes (`/api/auth/admin/*`) and `/sign-up/email` are disabled with `disabledPaths`. They would bypass `can()` and the audit log. Core services call the plugin's server API directly instead.
- Better Auth telemetry is off.
- Inactive users and the system user (`isSystem`) cannot sign in. A Better Auth hook rejects the session before it is created. Deactivating a user also revokes all of that user's sessions (the service ships here; the UI is M3).
- New environment variables are added to the `env.ts` schema and `.env.example`:
  - `BETTER_AUTH_SECRET`: at least 32 characters.
  - `BETTER_AUTH_URL`: a URL.
  - `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`: optional in the schema, required by the seed script.

### Acting context (`packages/core/context.ts`)

- The shared types:
  - `type Source = 'web' | 'mcp' | 'import' | 'system'`
  - `type Actor = { id: string; role: Role; active: boolean }`
  - `type Ctx = { user: Actor; source: Source }`
- Error classes: `UnauthenticatedError` and `ForbiddenError`. The error message names the action and the resource type, never another user's data.
- `assertCan(ctx, action, resource)` throws `ForbiddenError` when the check fails. Every service calls it as its first step.

### RBAC (`packages/core/rbac/`)

- `can(user, action, resource): boolean` is a pure, synchronous function with no database access.
- Actions are `read`, `list`, `create`, `update`, `delete`.
- The `resource` argument is either a **type** (for `create` and `list`, where no row exists yet) or an **instance** that carries the ownership fields the rule needs. Callers load those fields before checking.

  | Resource        | Instance fields                                      |
  | --------------- | ---------------------------------------------------- |
  | `user`          | `id`                                                 |
  | `master`        | (`client`, `sector`, `service`; no ownership fields) |
  | `settings`      | none                                                 |
  | `auditLog`      | `actorId`                                            |
  | `apiToken`      | none                                                 |
  | `enquiry`       | `ownerId`, `projectManagerIds[]`                     |
  | `quotation`     | `ownerId`, `projectManagerIds[]`                     |
  | `project`       | `managerId`, `quotationOwnerId`                      |
  | `purchaseOrder` | `projectManagerId`, `pipelineOwnerId`                |
  | `invoice`       | `projectManagerId`, `pipelineOwnerId`                |
  | `followUp`      | `userId`                                             |
  | `dashboard`     | `scope: 'company' \| 'personal' \| 'project'`        |
  - `projectManagerIds` holds the managers of any projects linked to the enquiry or quotation. It is empty until M8.
  - `pipelineOwnerId` is the `ownerId` of the quotation the PO or invoice ultimately comes from.

- **The rules.** They follow PLAN.md, with the interpretations listed under "Decisions".
  - An inactive user is denied everything.
  - `ADMIN` is allowed everything.
  - `user`: a user may `read` their own record. Every other action on users is admin-only.
  - `master`: all roles may `read` and `list` masters. Only admins may change them.
  - `settings`: all roles may `read` settings (the app needs the currency list and default due days). Only admins may `update` them.
  - `auditLog`:
    - `SALES` and `PROJECT_MANAGER` may `read` and `list` rows where `actorId === user.id`.
    - Rows are never created through `can()`; the M2 audit extension writes them.
    - Nobody may `update` or `delete` audit rows, admins included.
  - `apiToken`: admin only.
  - `enquiry` and `quotation`:
    - `SALES` has full CRUD where `ownerId === user.id`. Sales may also `create` (the new record is owned by the creator).
    - `PROJECT_MANAGER` may `read` a record when `projectManagerIds` includes `user.id`.
  - `project`:
    - `SALES` may `read` a project when `quotationOwnerId === user.id`. Sales may also `create` one (from their own PO_RECEIVED quotation).
    - `PROJECT_MANAGER` may `read` and `update` a project when `managerId === user.id`. PMs may not `create` or `delete` projects.
  - `purchaseOrder` and `invoice`:
    - `SALES` has CRUD when `pipelineOwnerId === user.id`.
    - `PROJECT_MANAGER` has CRUD when `projectManagerId === user.id`.
  - `followUp`: `SALES` and `PROJECT_MANAGER` have CRUD when `userId === user.id`.
  - `dashboard`:
    - `ADMIN` may see `company`.
    - `SALES` may see `personal`.
    - `PROJECT_MANAGER` may see `project`.
- **List scoping.** For type-level `list` checks, `can()` only answers whether the role may list that type at all. The row filter comes from a typed per-entity function in `rbac/scope.ts` that returns a Prisma `where` fragment. M1 ships `scopeUsers`. M2 adds `scopeAuditLog`, when the AuditLog model exists. Each later entity module adds its own filter, with tests.
- The rules live in one table-like module, `rbac/policy.ts`, so they can be reviewed against PLAN.md at a glance.

### Services (`packages/core/services/`)

- `user.service.ts` provides the first real services, which set the pattern (`ctx` first, `assertCan`):
  - `getCurrentUser(ctx)`
  - `getUser(ctx, id)`
  - `listUsers(ctx, { page, pageSize })`: admin only. It excludes the system user.
  - `deactivateUser(ctx, id)`: admin only. It revokes the user's sessions. An admin cannot deactivate themselves or the system user.
- `createUser` and role changes are M3.
- Zod schemas for these inputs go in `packages/core/schemas/user.ts`.

### Web (`apps/web`)

- Route handler `app/api/auth/[...all]/route.ts` mounts Better Auth from core.
- `proxy.ts` (Next 16's replacement for middleware) makes a quick cookie-presence check:
  - Everything except `/login`, `/api/auth/*`, `/api/health` and static assets redirects to `/login` when there is no session cookie.
  - This is only a convenience, not the security boundary.
- Server helpers in `lib/auth.ts`, which are the real guard:
  - `getCtx()` validates the session through core and returns `Ctx` with `source: 'web'`. It throws `UnauthenticatedError` when there is no valid session.
  - `requireRole(...roles)` builds on it.
- Server-action wrapper `lib/action.ts`:
  - It validates input with a shared Zod schema and builds `ctx`.
  - It maps `UnauthenticatedError`, `ForbiddenError` and `ZodError` to `{ ok: false, error }`, per the CLAUDE.md convention, and never throws to the client.
- Pages:
  - `/login`: a shadcn form (React Hook Form + `zodResolver`). It shows one generic error on failure: "Email or password is incorrect". It never reveals whether the email exists. The form uses `method="post"`, and its button stays disabled until the page has hydrated, so a native submit can never put credentials in the URL.
  - An app shell with a header showing the user's name and role, and a sign-out button.
  - `/`: the existing home page, now behind login.
  - `/admin`: an admin-only placeholder page (filled in by M3). Other roles get a 403 page.
  - `forbidden` and `unauthorized` states use Next's `forbidden()` / `unauthorized()` (or equivalent error pages).
- Dates in the UI use `Asia/Kolkata` (nothing time-based is shown yet beyond, possibly, the session).

### MCP and worker

- No auth changes in M1. MCP token auth is M13. The `Ctx` type already includes `source: 'mcp' | 'system'` so those modules can plug in.

### Seed (`packages/core/system/seed.ts`)

- The seed lives in core, because it uses the auth config. It is run by `pnpm db:seed` and by Prisma's seed hook through `packages/core/scripts/seed.ts`, invoked by path so there is no db → core dependency cycle.

- The seed is idempotent. It upserts the admin from `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`, and exits with a clear error if either is missing.
- In `NODE_ENV=development` it also seeds one `SALES` user and one `PROJECT_MANAGER` user with documented dev-only passwords. It never does this in production.
- It also upserts the **system user**: `System`, `system@internal`, `role: ADMIN`, `isSystem: true`. It has no credential account, so it can never sign in. Background jobs and imports act as this user (the `systemCtx()` helper arrives in M2), so every audit row has a real `actorId`.
- The seed goes through Better Auth's server API, so passwords are hashed the same way as at sign-in, and no hash is ever written by hand.

## Out of scope

- User-management UI (create, role change, reset password, deactivate): M3.
- Audit rows for auth and user changes: M2. M1 passes `ctx.source` everywhere so M2 can hook in.
- MCP token auth: M13.
- SSO/OAuth, two-factor auth, email verification, self-service password reset: not planned for v1.
- Row filters for entity lists (`scopeEnquiries` and the rest) ship with each entity module.
- Audit-row assertions in the `user.service` tests: added in M2 together with the audit extension.

## Acceptance criteria

**`can()` rules** (unit, table-driven: role × resource × action × own/other):

1. **AC1:** a `SALES` user cannot `read`, `update` or `delete` an enquiry whose `ownerId` is another user, and can do all three on their own enquiry. This is the "done when" test from PLAN.md. It uses an enquiry-shaped object, because the Enquiry model arrives in M4.
2. **AC2:** every row of the PLAN.md role table has at least one allow case and one deny case. That includes a PM reading a quotation for a project they manage (allowed) and for another project (denied), and the audit-log "own changes only" rule.
3. **AC3:** an inactive user of any role, `ADMIN` included, is denied every action.
4. **AC4:** nobody, admins included, may `update` or `delete` an `auditLog` row.

**Authentication** (integration, real test database):

5. **AC5:** the seeded admin can sign in with the right password. Sign-in fails with a wrong password or an unknown email, and both failures give the same error.
6. **AC6:** the public sign-up endpoint is rejected.
7. **AC7:** an inactive user cannot sign in. `deactivateUser` revokes that user's existing sessions, so their next request is unauthenticated.
8. **AC8:** running the seed twice leaves exactly one admin and one system user, and the admin's password still works. The system user cannot sign in, even when someone tries to set a password for it. The seed fails clearly when `SEED_ADMIN_*` is missing.
9. **AC9:** `env` rejects a `BETTER_AUTH_SECRET` shorter than 32 characters.

**Services** (integration):

10. **AC10:** each `user.service` method has a happy-path test and an RBAC-denial test. `listUsers` and `deactivateUser` throw `ForbiddenError` for `SALES` and `PM`. `getUser` on another user throws `ForbiddenError` for non-admins. An admin cannot deactivate themselves or the system user. `listUsers` never returns the system user.
11. **AC11:** `getCtx()` throws `UnauthenticatedError` without a session, and returns the correct `Ctx` (`source: 'web'`) with one.
12. **AC12:** the server-action wrapper returns `{ ok: false, error }` for unauthenticated, forbidden and invalid-input cases, and never throws to the client.

**End-to-end** (Playwright, one flow):

13. **AC13:** an unauthenticated visit to `/` redirects to `/login`. The admin signs in, sees their name and role in the header, and can open `/admin`. After sign-out, `/` redirects to `/login` again. A seeded `SALES` user signs in and sees the Forbidden page on `/admin`. The page is rendered by the admin layout; Next's `forbidden()` is still experimental in Next 16, so it is not used, and the HTTP status is 200.

**Quality:**

14. **AC14:** `pnpm typecheck && pnpm lint && pnpm test` pass, and the `m1_auth` migration applies cleanly to an empty database.

## Dependencies

| Package                                         | Where | Why                                                                                                                                  |
| ----------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `better-auth`                                   | core  | Auth, already in the CLAUDE.md stack.                                                                                                |
| `react-hook-form`, `@hookform/resolvers`, `zod` | web   | Login form with the shared Zod schema, all in the CLAUDE.md stack.                                                                   |
| `radix-ui`, `class-variance-authority`          | web   | Needed by the shadcn/ui components (`button`, `input`, `label`, `card`, `field`, `separator`), copied into `apps/web/components/ui`. |

The Better Auth CLI is not a dependency. `@better-auth/cli` is deprecated, and its replacement (`auth`) was run once with `pnpm dlx auth@1.7.6 generate` to get the table layout. shadcn's CLI also installed its own `cn` package; it was removed in favour of the existing `@/lib/utils` `cn()`, so there is one class-name helper.

## Risks (resolved during planning)

- **Better Auth + Prisma 7:** ✅ `better-auth@1.7.6` lists Prisma `^7` as a supported peer, and the Prisma adapter works with core's client (integration tests).
- **Role as an enum:** Better Auth's admin plugin treats `role` as a string. ✅ It round-trips through the `Role` enum column (`auth-role.integration.test.ts`). The roles are declared in the plugin config so its types match.
- **Next 16 `proxy.ts`:** ✅ It runs on the Node runtime by default. It still only checks for the cookie; the matcher excludes all of `/_next/` so dev HMR keeps working.
- **Schema generator:** `@better-auth/cli` on npm is at 1.4.x while `better-auth` is at 1.7.x. ✅ `@better-auth/cli` is deprecated; its replacement is the `auth` package, run once via `dlx`.

## Decisions

These interpret PLAN.md where it is silent or contradicts itself. They were settled when the spec was drafted.

1. **Project creation.** PLAN.md gives Sales only "Read, own clients" on projects, but the quotation's PO_RECEIVED step offers to create a project.
   - The quotation's `SALES` owner, or any admin, creates the project and assigns a PM.
   - PMs update the projects assigned to them, but cannot create or delete projects.
2. **Masters and settings.** PLAN.md's "No access" for non-admins means _no management_.
   - All roles can read clients, sectors, services and `CompanySettings`, which forms need for dropdowns, currencies and due-day defaults.
   - Only admins can change them.
3. **"Own clients" for Sales on projects** means projects whose source quotation that Sales user owns (`quotationOwnerId`). Clients have no owner field, and the wider reading ("any client I ever quoted") would leak other reps' deals.
4. **Deactivation** uses the `active` flag from the CLAUDE.md data model, not the admin plugin's `banned` fields.
   - It is enforced in three places: at sign-in, in `can()`, and by revoking the user's sessions.
   - The ban fields are added only if the plugin requires them, and are left unused.
5. **System actor.** A seeded `system@internal` user with `isSystem: true` acts for jobs and imports.
   - It has `ADMIN` rights so jobs can touch any record, but it can never sign in: it has no credential account, and the sign-in hook rejects it.
   - It is hidden from user lists and cannot be deactivated.
6. **Session and password policy.**
   - Sessions last 7 days and slide (the expiry refreshes daily while in use).
   - Passwords need at least 12 characters, with no composition rules, following NIST SP 800-63B.
   - Sign-in endpoints are rate limited.
   - These can be revisited in M14 hardening.

## Open questions

None blocking M1. The PLAN.md open questions for later modules still stand (quotation revisions for M6, multi-service enquiries for M4, and so on).
