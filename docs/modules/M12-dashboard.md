# M12 — Dashboards and reports

Depends on: M0–M11.

## Goal

One page that shows how the business stands: what is in the pipeline, how well we convert, what we won, who owes us money, and which clients bring the revenue. Each role sees the same page at its own scope: admins the company (optionally one owner), Sales their own pipeline, project managers their projects. Every panel exports to CSV.

- A **`/dashboard`** page on UI guide template 4.4: a KPI row, a pipeline funnel, receivables ageing, conversion by dimension, quoted vs won by month, and top clients by revenue.
- A **project manager layout** of the same page for the `project` scope.
- **INR equivalents** stored on every money record, so totals across currencies are meaningful (settles the PLAN.md open question; Decision 1).
- **Report periods** (Indian financial-year quarters, previous-period comparison) as a shared schema that M12b's sales reports reuse.
- **CSV export** per panel.

PLAN.md "done when": numbers match seeded fixtures. AC1 proves it with a golden test over the development seed for each role.

This module is the day-to-day operational view. Period reporting for management (enquiry volume by day/week/month, sector and service sales, new vs repeat customers, monthly revenue) is M12b (`docs/modules/M12b-sales-reports.md`), which builds on the period schema and INR equivalents defined here.

## Metric definitions (binding)

Every definition below goes on its query function as a doc comment and in the panel's ⓘ popover, word for word.

**Common rules**

- **Live records only** (`deletedAt` null), and only records whose client is live.
- **Money is INR**, from each record's stored `amountInrMinor` (Decision 1). A record without an INR equivalent (no rate yet) is left out of money totals but still counted, and the panel footnote says "3 USD records have no exchange rate yet" with a link to the rates page (admins).
- **Dates are IST calendar days.** "In the period" means the named date falls between the period's `from` and `to`, inclusive.
- **Snapshot panels** (open pipeline, receivables, ageing) describe today and ignore the period; their description says "As of today".
- **Previous period** = the same number of days immediately before (a quarter compares with the quarter before, a custom 45 days with the 45 days before).

**KPI row** (company and personal scope)

| KPI                 | Definition                                                                                                                                                                                                                                                                      | Delta                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Open pipeline       | Sum of `amountInrMinor` of quotations in `SENT` or `UNDER_NEGOTIATION`. Snapshot. Count underneath.                                                                                                                                                                             | None (snapshot)                      |
| Win rate            | Quotations won ÷ (won + lost) among quotations **decided in the period**: won = `PO_RECEIVED` with `poReceivedDate` in the period; lost = `LOST` with its `statusChangedAt` IST day in the period. By count; value-weighted rate in the tooltip. "—" when fewer than 3 decided. | Percentage points vs previous period |
| Won this period     | Sum of `amountInrMinor` of quotations won in the period (as above). The quotation amount is the won value (M8 Decision 15).                                                                                                                                                     | % vs previous period                 |
| Overdue receivables | Sum of `amountInrMinor` of invoices with `status = OVERDUE`. Snapshot. Count underneath.                                                                                                                                                                                        | None (snapshot)                      |

**Pipeline funnel** (cohort = enquiries with `receivedDate` in the period)

| Stage         | An enquiry reaches it when                               |
| ------------- | -------------------------------------------------------- |
| Enquiries     | It is in the cohort                                      |
| Proposal sent | It has a `proposalSentDate` (converted or not)           |
| Quoted        | It has at least one live quotation                       |
| Won           | One of its quotations is `PO_RECEIVED`                   |
| Invoiced      | A live project under a won quotation has a live invoice  |
| Paid          | It is invoiced and every live invoice under it is `PAID` |

- Counts per stage and the conversion from the previous stage (%). Stages are cumulative: an enquiry counted at a stage is counted at every earlier one.
- Tooltip values: Quoted = sum of the latest live quotation per enquiry (by `quotationDate`, then `createdAt`); Won = sum of won quotations.
- Bars use the pipeline stage colours (UI guide 4.4).

**Receivables ageing** (snapshot)

- Unpaid (`PENDING` or `OVERDUE`) live invoices, bucketed by days past `dueDate` as of today (IST): **Not yet due** (due today or later), **1–30**, **31–60**, **61–90**, **Over 90** days overdue.
- Value (INR) and count per bucket; the total equals outstanding receivables.
- Footnote: **DSO** = outstanding ÷ invoiced in the last 90 days × 90, rounded to whole days; "—" when nothing was invoiced in 90 days.

**Conversion by** (toggle: Sector, Service, Owner, Source)

- The win-rate definition above, grouped by the quotation's **sector**, each of the quotation's **services** (a quotation with two services counts once in each; counts only, since quotations carry no per-service value), the quotation's **owner** (admins only), or the enquiry's **source**.
- Each bar: win rate, with won and lost counts in the label ("62% · 8 won, 5 lost"). Groups with fewer than 3 decided quotations show "—" and sort last. Sorted by decided count, then name.

**Quoted vs won by month**

- Monthly buckets (IST) covering the period; a period shorter than three months shows the six months ending with the period's last month.
- **Quoted** = sum of `amountInrMinor` of quotations by `quotationDate`. **Won** = sum of won quotations by `poReceivedDate`. Lost quotations are not a series; their value is in the tooltip.
- Both series count quotations in any status, so quoted and won describe the same records (pre-tax or not, as the quotation was written).

**Top clients by revenue** (table)

- Clients ranked by **invoiced** in the period: sum of `amountInrMinor` of invoices by `invoiceDate`. Columns: client, invoiced, collected (invoices `PAID` with `paidAt` in the period), outstanding now (snapshot), won in the period, open pipeline now (snapshot). Top 10; the CSV has all clients with any value.
- Invoice amounts include taxes (M10 Decision 9); quotation amounts are as written. The column headers say so ("Invoiced (incl. tax)").

**Project manager layout** (project scope: projects with `managerId` = the user)

| KPI                  | Definition                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Active projects      | `NOT_STARTED`, `IN_PROGRESS` or `ON_HOLD`. Snapshot.                                          |
| Behind schedule      | Active with `endDate` before today (M8's rule). Snapshot.                                     |
| Invoiced this period | Sum of `amountInrMinor` of invoices on their projects by `invoiceDate`; % vs previous period. |
| Overdue receivables  | As above, on their projects.                                                                  |

Panels: **Projects by status** (bars, snapshot), **Receivables ageing** (their projects), **Delivered in the period** (projects `COMPLETED` with `completedDate` in the period: planned end, completed, days late or early), **Billing by project** (active and recently completed projects: revenue, invoiced, paid, outstanding; M10's per-PO billing summed in INR).

## In scope

### Database (`packages/db`)

- **`ExchangeRate`** (Decision 1): `id`, `currency String` (ISO 4217, not INR), `month DateTime @db.Date` (first day of the month), `inrPerUnit Decimal @db.Decimal(14, 6)`, `createdAt`, `updatedAt`, `deletedAt`. Partial unique index on `(currency, month) WHERE "deletedAt" IS NULL`. `CHECK ("inrPerUnit" > 0)`, `CHECK (extract(day from "month") = 1)`. A rate is exact decimal, not a float (CLAUDE.md money rule covers the amounts it produces).
- **`amountInrMinor BigInt?`** and **`fxRate Decimal? @db.Decimal(14, 6)`** on `Quotation`, `Project` (for `revenueMinor`), `PurchaseOrder` and `Invoice`. For INR records `fxRate = 1` and `amountInrMinor = amountMinor`. For others, the rate for the record's **own date** month (quotation: `quotationDate`; project: its quotation's `poReceivedDate`; PO: `receivedDate`; invoice: `invoiceDate`), or null when no rate exists yet.
- `CHECK (("amountInrMinor" IS NULL) = ("fxRate" IS NULL))` on each, and `CHECK ("currency" <> 'INR' OR ("fxRate" = 1 AND "amountInrMinor" = "amountMinor"))` (Project uses `revenueMinor`).
- Indexes for the dashboard: `Quotation(status, poReceivedDate)`, `Quotation(status, statusChangedAt)`, `Invoice(paidAt)`, `Invoice(invoiceDate)`, `Enquiry(receivedDate)`, `Project(managerId, completedDate)`. Existing indexes cover the rest (`Invoice(status, dueDate)`, `Quotation(status, quotationDate)`).
- **Backfill** in the migration SQL: INR records get `fxRate = 1`, `amountInrMinor = amountMinor`. Non-INR records stay null until rates exist; the first `pnpm db:seed` (dev) or an admin adding rates fills them (below).
- `ExchangeRate` is audited automatically; the M2 coverage test must pass.
- Migration: `m12_dashboard`.

### Money (`packages/core/schemas/money.ts`, `packages/core/services/fx.ts`)

- **`toInrMinor(amountMinor, currency, inrPerUnit)`**: converts minor units through the currencies' fraction digits (`currencyFractionDigits`), multiplies by the decimal rate in exact arithmetic (rate as a scaled `bigint`), and rounds half up to the paisa. Never `Number`.
- **`formatInrShort(amountMinor)`**: Indian abbreviations for chart axes and tiles: `₹950`, `₹12.5K`, `₹12.5L`, `₹1.2Cr` (UI guide 4.4). Full values use the existing `formatMoney`.
- **`applyFx(tx, model, record)`** (internal): sets `fxRate` and `amountInrMinor` on a record from its currency, amount and date. Called inside the existing create and update paths of quotations, projects, POs and invoices **whenever the amount, currency or the record's date changes**, in the same transaction, so the INR value is always audited with the change that caused it.
- **`fillMissingFx(systemCtx, { currency, month })`**: after a rate is added, fills `amountInrMinor` on records of that currency and month that have none, in batches, each an audited `system` write. Existing values are never rewritten when a rate is later edited (Decision 2); an admin can re-apply a month explicitly (**Recalculate** on the rate, audited, with a confirmation that says how many records change).

### RBAC (`packages/core/rbac`)

- The M1 `dashboard` rule stays: admins read every scope; Sales `personal`; PMs `project`.
- **`exchangeRate`**: admins manage; everyone reads (forms show the rate applied). New resource in `types.ts` and `policy.ts`.
- Scope resolution in the service (Decision 4):
  - Admin: `company` (all), optionally narrowed by `ownerId` (a Sales user; pipeline panels by quotation owner, receivables and clients by pipeline owner), or `managerId` for the project layout of one PM.
  - Sales: `personal`, owner forced to themselves; `ownerId`/`managerId` in the input are refused.
  - PM: `project`, manager forced to themselves.
- Every query ANDs the entity's existing scope function with the resolved dashboard scope, so a panel never counts a record its viewer cannot read.

### Schemas (`packages/core/schemas`)

- **`report.ts`** (shared with M12b):
  - `REPORT_PRESETS`: `thisMonth`, `lastMonth`, `thisQuarter`, `lastQuarter`, `thisFinancialYear`, `lastFinancialYear`, `custom`. Quarters are Indian financial-year quarters: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar (Decision 3).
  - `reportPeriodSchema`: `{ preset, from?, to? }`; `from`/`to` required for `custom`, `from ≤ to`, at most 3 years.
  - Pure helpers: `resolvePeriod(input, today) → { from, to, label }`, `previousPeriod(period)`, `monthsIn(period)`, `fyLabel(date)` ("FY 2026–27", "Q2 FY 2026–27").
- **`dashboard.ts`**: `dashboardInputSchema` = `reportPeriodSchema` + `ownerId?`, `managerId?`, `dimension?` (`sector | service | owner | source`, default `sector`). DTO types for each panel. `DASHBOARD_PANELS` (ids for export).
- **`exchange-rate.ts`**: create/update schemas (`currency` enabled and not INR, `month` as `YYYY-MM`, `inrPerUnit` as a decimal string with at most 6 decimals, > 0).

### Services

**`packages/core/services/dashboard.service.ts`** (read-only; no writes, no audit rows)

- `getDashboard(ctx, input, { today })`: validates, resolves the scope and period, `assertCan(ctx, 'read', { type: 'dashboard', scope })`, then runs the panel queries in parallel and returns `{ scope, period, previous, kpis, funnel, ageing, conversion, quotedVsWon, topClients, missingFx }` (company/personal) or `{ scope, period, previous, kpis, projectsByStatus, ageing, delivered, billing, missingFx }` (project).
- `exportDashboardPanel(ctx, input, panel)`: the same data as rows for CSV (`{ columns, rows }`); money as rupee strings with two decimals, not abbreviated.
- Panel queries live in `services/dashboard/` (`kpis.ts`, `funnel.ts`, `ageing.ts`, `conversion.ts`, `quoted-vs-won.ts`, `top-clients.ts`, `projects.ts`), not exported from the package. Aggregation happens in SQL (`groupBy`, or `$queryRaw` with `date_trunc` on IST dates and `generate_series` for zero-filled months); no loading rows into JavaScript to sum them.

**`packages/core/services/exchange-rate.service.ts`**: `listExchangeRates`, `createExchangeRate` (then `fillMissingFx` for that currency and month, same request id), `updateExchangeRate`, `recalculateExchangeRate`, `softDeleteExchangeRate` (refused while records use it: "12 records use this rate"), each with `assertCan` and `withTx`.

**Changes to existing services**: `quotation.service`, `project.service`, `purchase-order.service` and `invoice.service` call `applyFx` on create and on any change to amount, currency or the record's date (Decision 2). Their detail views return `amountInrMinor` and `fxRate` so the UI can show "≈ ₹10,37,500 at 83.00".

### Seed

- USD rates for every month the samples touch (e.g. 83.00–84.50), created through `createExchangeRate`, so the backfill fills the sample USD quotation.
- Add invoices so every ageing bucket has one (1–30, 31–60, 61–90, over 90 days overdue), a won and a lost quotation decided in the current quarter and the previous one (so win-rate deltas exist), and a project completed late in the current quarter.
- Idempotent, as M4–M11.

### Web (`apps/web`)

Follows `docs/UI-GUIDE.md` 4.4 (dashboard) and its checklist, and the `dataviz` guidance for every chart.

- **Nav:** **Dashboard** after My today, for every role.
- **`/dashboard`**:
  - `PageHeader`: "Dashboard" · the period label and "compared with" the previous one. Actions: **Period** select (presets; Custom opens two date inputs), **Owner** select (admins; "All owners" or a Sales user), **Manager** select (admins; switches to a PM's project layout). All in the URL.
  - KPI row: four tiles (label, 28px tabular value via `formatInrShort` with the full value in a tooltip, delta with ▲/▼ in success/destructive, or "As of today" for snapshots).
  - Panels in the 12-column grid as UI guide 4.4 sketches: funnel (8) + ageing (4); conversion (6) + quoted vs won (6); top clients (12). Each `Panel` has ⓘ (definition popover), **Export CSV**, and its own empty state ("No quotations were decided in this period").
  - Drill-down: a funnel stage, an ageing bucket, a conversion bar and a client row link to the list page with the matching filters where the list supports them (quotations by status, sector, service, owner; invoices by due window and client; enquiries by received range). Lists gain the filters they lack for this (`quotations`: `decidedFrom/To`; `invoices`: `overdueDays` bucket).
  - Charts: Recharts, horizontal gridlines only, 12px muted axis labels, INR axes abbreviated, popover-style tooltips, legend only with more than one series, `--chart-*` and pipeline tokens only. Each chart has a visually hidden table of its data for screen readers.
  - Missing-rate footnote under affected panels.
  - PM layout as defined above.
  - Loading: per-panel skeletons through route `loading.tsx`; error: route `error.tsx`.
- **`/api/dashboard/export`** (route handler, `GET ?panel=…&period…`): calls `exportDashboardPanel`, streams `text/csv` with a filename like `dashboard-top-clients-Q2-FY2026-27.csv` and a UTF-8 BOM (Excel shows ₹ correctly).
- **`/admin/exchange-rates`**: list (currency, month, rate, records using it), create/edit sheet, **Recalculate** and **Delete** in the row menu. Admin nav gains **Exchange rates**.
- **Money on detail pages**: non-INR quotations, projects, POs and invoices show the INR equivalent under the amount ("≈ ₹10,37,500 at 83.00 INR/USD, Oct 2026"), or "No INR rate for Oct 2026 yet" (UI guide §11 listed this as waiting for M12).

## Out of scope

- The six period reports in M12b (enquiry volume, enquiry status, sector POs, service sales, new vs repeat customers, monthly revenue) and PDF export.
- Targets, quotas and forecasting; scheduled or emailed reports (M14 digest is My Today only).
- Per-service value splits (M12b's PO lines).
- Live exchange-rate feeds: admins enter monthly rates.
- Claude API spend reporting (M7 logs usage): M14.
- MCP tools (`pipeline_summary`, `overdue_invoices`, `revenue_breakdown`): M13, calling `getDashboard`.

## Acceptance criteria

**Service and data** (integration tests against the test database, fixed `today`):

1. **AC1 (the "done when", golden test):** after `pnpm db:seed` with the clock pinned, `getDashboard` for the admin (company, and narrowed to one owner), each Sales user and the PM returns exactly the KPIs, funnel, ageing, conversion (all four dimensions), quoted-vs-won and top-clients numbers in a checked-in fixture.
2. **AC2 (INR equivalents):**
   - Creating an INR record sets `fxRate = 1` and `amountInrMinor = amountMinor`; a USD quotation dated in a month with a rate of 83.125 stores the converted paise, rounded half up; a USD invoice uses its own `invoiceDate` month, not the quotation's.
   - Editing the amount, currency or date recomputes it in the same transaction and audit row; editing a description does not.
   - With no rate, the record saves with nulls. Adding the rate fills it (audited `system` rows with the admin action's request id); editing the rate later leaves it unchanged until **Recalculate**.
   - The DB `CHECK`s reject a half-set pair and an INR record with a rate other than 1.
   - `toInrMinor` unit tests: JPY (0 decimals), USD, KWD (3 decimals), large amounts beyond 2^53, and half-up rounding.
3. **AC3 (periods, unit):** each preset for dates in every quarter, including 31 March and 1 April (FY boundary) and 23:30 IST on a quarter's last day; `previousPeriod` for a quarter, a month and a custom 45 days; custom `from > to` and a 4-year range are refused.
4. **AC4 (KPIs):** open pipeline counts `SENT` and `UNDER_NEGOTIATION` only; win rate uses the decision dates and shows "—" under 3 decided; won this period uses `poReceivedDate` and the quotation amount; overdue receivables equal the sum of `OVERDUE` invoices. Deltas are right for an increase, a decrease, no change and no previous data.
5. **AC5 (funnel):** stages are cumulative; an enquiry with two quotations (one lost, one won) counts once at every stage; an invoiced but partly paid enquiry stops at Invoiced; a deleted quotation does not count as Quoted.
6. **AC6 (ageing):** invoices due today, 1, 30, 31, 60, 61, 90 and 91 days ago land in the right buckets; paid and deleted invoices are excluded; bucket totals equal outstanding; DSO matches the fixture and is "—" with nothing invoiced in 90 days.
7. **AC7 (conversion and quoted vs won):** a two-service quotation counts once per service; groups under 3 decided show "—" and sort last; owner is refused for non-admins; months with nothing show 0; a one-month period shows six months.
8. **AC8 (top clients and PM layout):** columns use their own dates; the top 10 are ranked by invoiced; the CSV includes every client with a value. For the PM: only their projects; delivered shows days late for a project completed after its planned end.
9. **AC9 (RBAC):** Sales get their personal scope and are refused `ownerId`/`managerId`; PMs get the project layout and are refused the company scope; admins can narrow to any owner or manager; no panel counts a record the viewer cannot read (a test re-reads contributing records as the viewer). Exchange-rate writes are admin-only. Every service function has happy-path, denial and audit-row (or no-audit-row, for reads) tests.
10. **AC10 (missing rates):** a USD record without a rate is counted in counts, left out of money totals, and reported in `missingFx`; adding the rate makes the totals match.
11. **AC11 (exports):** each panel's CSV has the documented columns, full rupee values, the BOM and the scoped rows only; a Sales user cannot export company data.
12. **AC12 (performance):** on the seed ×10, `getDashboard` for the admin runs under 500 ms locally with a fixed number of queries.

**End-to-end** (Playwright):

13. **AC13 (admin):** the dashboard shows the seeded KPIs, switching the period to last quarter changes them, a funnel stage opens the filtered quotation list, and a CSV downloads with the expected header row.
14. **AC14 (Sales and PM):** a Sales user sees their own numbers without owner or manager selects; the PM sees the project layout.
15. **AC15 (exchange rate):** an admin adds a USD rate for a month with an unconverted quotation; the dashboard's missing-rate footnote disappears and the quotation page shows the INR equivalent.

**Quality:**

16. **AC16:** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build` pass. `m12_dashboard` applies after M11. `ExchangeRate` passes the M2 audit coverage test. UI guide checklist run on `/dashboard` and `/admin/exchange-rates`, in light and dark mode, at 375, 768, 1024 and 1440px.

## Decisions

1. **INR equivalents are stored per record, at the rate for the record's own month** (confirmed by the product owner; settles the PLAN.md open question "which rate: quote date or current?" as _the record's date_). Each quotation, project, PO and invoice keeps `amountInrMinor` and the `fxRate` used. Converting at report time with today's rate would change last year's figures every month; converting at the quotation date for everything would value a later invoice at the wrong rate. Rates are monthly and admin-entered, because the company invoices at monthly accounting rates and nobody wants a live feed deciding revenue. M12b's "rate entered by the user on each record" is not adopted: one monthly table is fewer mistakes, and admins can still recalculate a month.
2. **A stored INR value changes only when its record changes, or when an admin recalculates a month.** Editing a rate does not silently rewrite history; the Recalculate action says how many records change and is audited.
3. **Reports use the Indian financial year** (April–March, quarters Q1 Apr–Jun; confirmed by the product owner). Record numbering stays on the calendar year (M4 Decision 9); the two serve different readers.
4. **One page, three scopes**, per the M1 `dashboard` rule: company (admins), personal (Sales), project (PMs). Admins can narrow to an owner or a PM, which covers "how is this rep doing" without a separate page.
5. **Won value is the quotation amount** (M8 Decision 15), in INR at the quotation's month. Project revenue is shown on the PM layout's billing table, where it is the working figure.
6. **Win rate counts decisions in the period**, not enquiries received in it, so a quarter's win rate is final at the quarter's end. The funnel is the cohort view (what happened to what came in), so both questions are answered without mixing them.
7. **Snapshots ignore the period and say so.** Open pipeline, outstanding and ageing are "now" questions; a period filter on them would need history the app does not keep.
8. **Exports are not audited.** M2 audits mutations; an export is a read of data the user can already see on screen. M12b's `report.export` audit action would need a read-audit mechanism; left to M12b to justify.
9. **No caching in v1.** SQL aggregation on the indexed columns is fast enough at this company's volumes (AC12 guards it); a cache would need invalidation on every pipeline write.

## Dependencies

- **`recharts`** (web): the chart library named in CLAUDE.md's stack and UI guide 4.4, not yet installed because no module has drawn a chart. No other chart library.
- Everything else exists: Prisma `Decimal`, `Panel`, `PageHeader`, `Money`, `DateDisplay`, `SummaryStrip`, list filters, `todayInIST`, the scope functions and `billingFor`.

## Risks

- **Currency history.** Existing USD records have no INR value until rates are entered; the missing-rate footnote and the backfill cover it, but the first production deploy needs an admin to enter rates for past months. M14's deploy checklist should include it.
- **Decimal arithmetic.** Rates are `Decimal` in Postgres and must never pass through `Number`. `toInrMinor` works in scaled `bigint`; AC2 includes amounts beyond 2^53.
- **Time zones.** Month and quarter buckets, decision dates from `statusChangedAt` (a timestamp) and ageing all use IST days. `date_trunc` must run on the IST-converted value, and tests pin the 23:30 IST edge (AC3).
- **Definitions drift between M12 and M12b.** Both must import the same period helpers and state the same definitions; M12b's spec should reference this one's metric definitions where they overlap (win rate, revenue dates).
- **Tax mix.** Quotations may be pre-tax while invoices include tax, so "won" and "invoiced" are not directly comparable. The column headers say which is which; the M9 over-coverage risk still applies.

## Open questions

Settled by the product owner: INR equivalents stored per record at the monthly rate for the record's own date, with admin-maintained monthly rates (Decision 1; PLAN.md updated); reports on the Indian financial year (Decision 3); M12b revised to use this module's INR equivalents, period schema and unaudited exports.

None open.
