# M12b — Sales reports

**Depends on:** M4 Enquiries, M6 Quotations, M8 Projects, M9 Purchase orders, M10 Invoices, M12 Dashboards.
**Build before:** M13 (the MCP server exposes these reports as tools).
**Follow:** `CLAUDE.md` and `docs/UI-GUIDE.md` (dashboard template, tokens, chart rules).

## Goal

Add a **Reports** page that answers six management questions on one screen. Each answer is brief: one plain-language headline sentence, one chart, and at most one small table. Management should grasp the state of sales in under a minute and be able to export it as a PDF.

M12's dashboard is for day-to-day operations (pipeline, receivables). This module is for period reporting: what happened this week, month or quarter.

| #   | Question                                                | Answer shown as                                              |
| --- | ------------------------------------------------------- | ------------------------------------------------------------ |
| R1  | How many enquiries did we receive per day, week, month? | Column chart over time + total and change vs previous period |
| R2  | What is the status of our enquiries?                    | 100% stacked bar + counts and percentages                    |
| R3  | Which sectors are giving us POs?                        | Horizontal bar chart, sorted                                 |
| R4  | Which services sell best?                               | Horizontal bar chart, sorted, by value                       |
| R5  | Are we winning new customers or repeat business?        | Stacked columns by month + two short lists                   |
| R6  | What is our monthly revenue?                            | Columns (invoiced) + line (collected) + monthly detail table |

---

## Metric definitions (source of truth)

These definitions are binding. Put each one in the code as a doc comment on its query function and show it in the panel's info tooltip.

**Common rules**

- Period filter applies to the date named in each metric. All date bucketing uses **Asia/Kolkata**. Weeks start **Monday** (ISO weeks).
- Soft-deleted records are excluded.
- Money is reported in **INR**. Use the record's stored INR equivalent (`amountInrMinor`, added by M12 at the monthly rate for the record's own date; M12 Decision 1). Never convert at report time with today's rate. Records without a rate yet are left out of money totals and reported in a footnote, as on the M12 dashboard.
- "Previous period" = the same length of time immediately before the selected period (e.g. September vs August; 1–15 Oct vs 16–30 Sep).

**R1 — Total enquiries**

- Count of enquiries by `receivedDate`, bucketed by the selected granularity: day, week or month.
- Headline: total in the period and % change vs the previous period.
- Default granularity by period length: ≤ 31 days → day; ≤ 6 months → week; longer → month. User can override.
- Buckets with zero enquiries are shown as zero, not skipped.

**R2 — Enquiry status**

Cohort = enquiries received in the period. Each enquiry falls in exactly one bucket:

| Bucket            | Rule                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Converted into PO | Enquiry has a quotation with status `PO_RECEIVED`, or a linked project with at least one PO               |
| Lost              | Enquiry status `LOST`                                                                                     |
| Under pipeline    | Everything else (enquiry `IN_PROGRESS`, or `CONVERTED` with quotation still `SENT` / `UNDER_NEGOTIATION`) |

- Show count and % of cohort for each bucket; the three add up to 100%.
- Secondary figure: **conversion rate** = converted ÷ (converted + lost), i.e. excluding still-open enquiries. Label it clearly as "Win rate on decided enquiries". It is enquiry-level and cohort-based, unlike the M12 dashboard's win rate (quotations decided in the period); the two labels must stay distinct.
- Under pipeline is split in the tooltip: "Enquiry in progress" vs "Quotation sent / negotiating".

**R3 — Sector-wise POs**

- POs with `receivedDate` in the period, grouped by the **client's sector**.
- Show both **count** and **value** (INR); the chart plots value by default with a toggle to count.
- Show the top 6 sectors; group the rest as **"Other sectors"**. Sectors marked "Other" in the master data also go into "Other sectors".
- Sorted descending. Each bar labelled with value and share of total (e.g. "₹48.2L · 31%").

**R4 — Service-wise sales**

- PO line value (see schema changes) with PO `receivedDate` in the period, grouped by service.
- Rank by **value**; show count of POs containing that service in the tooltip.
- Show the top 7; the rest become **"Other services"**.
- The best seller gets a short headline: "ESG was the top service at ₹32.5L (24% of sales)."

**R5 — Customer analysis**

| Term         | Rule                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| New customer | Client whose **first-ever enquiry** has `receivedDate` in the period                      |
| New enquiry  | Any enquiry in the period from a new customer                                             |
| Repeat order | A PO in the period from a client that had **at least one earlier PO** (by `receivedDate`) |
| First order  | A PO in the period that is the client's first-ever PO                                     |

- Chart: stacked columns per month in the period — first orders vs repeat orders (count), with repeat-order value in the tooltip.
- KPIs: new customers, repeat orders, **repeat share of PO value** (%).
- Two compact tables, max 10 rows each, "View all" links to the filtered list page:
  - **New enquiries from new customers:** client, sector, service, received date, owner, status.
  - **Repeat orders:** client, PO number, service(s), value, received date, number of previous orders.

**R6 — Revenue**

Three measures per month, each on its own date:

| Measure   | Rule                                                  |
| --------- | ----------------------------------------------------- |
| Invoiced  | Sum of invoice amounts by `invoiceDate`               |
| Collected | Sum of invoice amounts with status `PAID` by `paidAt` |
| PO booked | Sum of PO amounts by `receivedDate` (order intake)    |

- Chart: columns = invoiced, line = collected, per month. PO booked appears in the table only, to keep the chart simple.
- Headline: invoiced this period, change vs previous period, and collection rate (collected ÷ invoiced).
- Detail table, one row per month, newest first: month, invoices (count), invoiced, collected, outstanding at month end, PO booked, top client by invoiced value.
- "Revenue" in labels always means **invoiced** unless stated.

---

## Schema changes

Add these in a migration for this module (update M9/M10 forms if already built):

1. **`PurchaseOrderLine`**: `id, purchaseOrderId, serviceId, amountMinor, currency, amountInrMinor`. A PO has one or more lines. The sum of lines must equal the PO amount (validated in `core`).
   - PO form: when a PO has one service, create one line automatically for the full amount. With several services, the user splits the amount; the form pre-fills an equal split and shows the remaining unallocated amount.
   - Data migration: existing POs with one service get one line; POs with several services get an equal split and `allocationEstimated = true`. R4 marks estimated data in a footnote.
2. **INR equivalents come from M12**, not from this module: `ExchangeRate` (admin-entered monthly rates) and `amountInrMinor` + `fxRate` on `Quotation`, `Project`, `PurchaseOrder` and `Invoice`. `PurchaseOrderLine.amountInrMinor` is the line amount converted at its PO's `fxRate`, set whenever the line or the PO's rate changes; the lines' INR values must sum to the PO's.
3. **`Sector.isOther`** (boolean) so admins can mark a sector as belonging to "Other sectors".
4. Indexes: `Enquiry(receivedDate)`, `Enquiry(clientId, receivedDate)`, `PurchaseOrder(receivedDate)`, `PurchaseOrder(clientId, receivedDate)`, `Invoice(invoiceDate)`, `Invoice(paidAt)`.

Seed data must include the sectors (Metal industry, Agriculture, Pharmaceutical, plus a few others) and services (EcoVadis, ESIA, Climate change, ESG, HSE, Sustainability, plus a few others) from the requirements.

---

## Backend

```
packages/core/reports/
  filters.ts            ReportFilter (M12 reportPeriodSchema + granularity) and bucketing helpers
  enquiry-volume.ts     R1
  enquiry-status.ts     R2
  sector-pos.ts         R3
  service-sales.ts      R4
  customer-mix.ts       R5
  revenue.ts            R6
  headlines.ts          deterministic headline sentences from the results
  index.ts              getSalesReport(ctx, filter) → all six, run in parallel
```

- **Filter** (`ReportFilter`): M12's `reportPeriodSchema` (`packages/core/schemas/report.ts`: presets, Indian financial-year quarters, `previousPeriod`) extended with `granularity` (`day | week | month`, optional), `ownerId?`, `sectorId?`, `serviceId?`. This module adds the `thisWeek` and `lastWeek` presets to the shared schema; the rest (This month, Last month, This quarter, Last quarter, This financial year, Custom) are M12's.
- Each function returns a typed DTO: `{ headline, data, previous?, definition, estimated? }`.
- Use SQL aggregation (`$queryRaw` with `date_trunc(... AT TIME ZONE 'Asia/Kolkata')` and `generate_series` for zero-filled buckets). Don't load rows into JS to aggregate.
- **Headlines are generated by code, not an LLM**: fixed sentence templates filled from the numbers, e.g. "124 enquiries this month, up 18% on last month." Handle zero, no previous data, and no change without awkward wording.
- **RBAC:** `ADMIN` sees company-wide reports and can filter by owner. `SALES` sees reports scoped to their own records (owner filter forced to themselves, not removable). `PROJECT_MANAGER` has no access to Reports.
- Cache each report result for 5 minutes, keyed by filter and user scope. Invalidate on writes to enquiries, POs or invoices.
- Reads and exports are not audited (M12 Decision 8: the M2 audit log records mutations, and an export is a read of data the user can already see).

---

## UI

Route: `/reports`, sidebar item **Reports** (below Dashboard, bar-chart icon). Follows the **dashboard template** in `docs/UI-GUIDE.md`.

```
PageHeader: "Sales reports" · "1 Oct – 31 Oct 2026 compared with 1 Sep – 30 Sep 2026"
                                                        [Download PDF] [Export CSV ▾]
Filter bar: [Period: This month ▾] [Granularity: Auto ▾] [Owner ▾] [Sector ▾] [Service ▾]

KPI row: Enquiries | Win rate on decided | POs received (value) | Invoiced revenue

┌─ R1 Enquiries received ──────────────────────┐┌─ R2 Enquiry status ──────────┐
│ headline                                      ││ headline                     │
│ column chart (8 cols)                         ││ 100% stacked bar + legend    │
│                                               ││ with counts and %  (4 cols)  │
└───────────────────────────────────────────────┘└──────────────────────────────┘
┌─ R3 POs by sector ─────────────┐┌─ R4 Top services ─────────────────────────┐
│ headline · [Value | Count]      ││ headline                                  │
│ horizontal bars (6 cols)        ││ horizontal bars (6 cols)                  │
└─────────────────────────────────┘└───────────────────────────────────────────┘
┌─ R5 New and repeat customers ─────────────────────────────────────────────┐
│ headline · 3 KPIs                                                           │
│ stacked columns (first vs repeat)  │  New enquiries (10)  │  Repeat orders (10)│
└─────────────────────────────────────────────────────────────────────────────┘
┌─ R6 Monthly revenue ───────────────────────────────────────────────────────┐
│ headline                                                                    │
│ columns invoiced + line collected                                           │
│ monthly detail table                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Panel pattern** (same for all six): title phrased as the answer area ("Enquiries received"), headline sentence in 14px directly under the title, the chart, then a 12px muted footnote with the definition link (ⓘ opens a popover with the definition from this spec). Maximum one chart per panel.

**Chart rules** (in addition to UI-GUIDE section 4.4):

- R1: columns in `--chart-1`; the previous period as a faint `--chart-4` line for comparison. Tooltip shows date range of the bucket and count.
- R2: status colours `--success` (converted), `--neutral` (under pipeline), `--destructive` (lost). The legend lists the count and % so the chart is readable without hovering.
- R3, R4: single colour `--chart-1`; "Other…" bars in `--neutral`. Value labels at bar ends. No axis needed when bars are labelled.
- R5: first orders `--chart-1`, repeat orders `--chart-2`.
- R6: invoiced columns `--chart-1`, collected line `--chart-2`. Y axis in abbreviated Indian units (₹12.5L, ₹1.2Cr).
- Every bar and segment is clickable and opens the matching list page with filters applied (e.g. clicking "Pharmaceutical" opens POs filtered by that sector and period).
- No pies, no 3D, no gradients, no data labels that overlap. At < 768px, charts go full width and tables become cards.

**States:** skeleton per panel while loading; each panel loads independently so one slow query doesn't block the page. Empty period: "No enquiries were received in this period." with a link to change the period. Estimated service split (R4): footnote "Some multi-service POs use an estimated equal split."

**Exports:**

- **Download PDF:** a print stylesheet (`@media print`) that lays the six panels out on A4 portrait, two pages max, with company name, period and generated date in the header. Use the browser's print-to-PDF; no server-side PDF library.
- **Export CSV:** a menu with one CSV per report (R1–R6), each containing the data behind the chart plus the definition as a comment line.

---

## MCP (for M13)

Expose these as read-only tools calling the same `core/reports` functions with the token user's scope:

`report_enquiry_volume`, `report_enquiry_status`, `report_sector_pos`, `report_service_sales`, `report_customer_mix`, `report_revenue`, and `report_sales_summary` (all six plus headlines, for questions like "How did we do last quarter?").

---

## Acceptance criteria

Write these as tests first, using a fixed seed with known answers.

1. **R1:** Enquiries are counted in the correct day, week and month buckets, including an enquiry received at 23:30 IST on a month's last day (must count in that month, not the next). Zero-enquiry buckets appear as 0. Week buckets start on Monday.
2. **R2:** Each enquiry in the cohort lands in exactly one bucket; bucket counts sum to the cohort size; percentages sum to 100 (rounding handled so displayed values sum to 100). Win rate excludes under-pipeline enquiries.
3. **R3:** Sectors beyond the top 6 and sectors with `isOther = true` are grouped into "Other sectors". Count and value toggles both match the fixture.
4. **R4:** Service totals come from PO lines; a multi-service PO contributes to each of its services by line amount; the total across services equals total PO value for the period. Estimated splits set `estimated: true`.
5. **R5:** A client's first PO counts as a first order; their second PO (even in the same month) counts as a repeat order. A client whose first enquiry was before the period is not a new customer even if they enquired again in the period.
6. **R6:** Invoiced uses `invoiceDate`, collected uses `paidAt`; a USD invoice uses its stored `amountInrMinor`. Outstanding at month end is correct for an invoice paid the following month.
7. **Headlines** render correctly for: an increase, a decrease, no change, zero in the current period, and no previous-period data.
8. **RBAC:** a sales user sees only their own records and cannot remove the owner filter; a project manager gets 403 on `/reports` and on the report functions.
9. **UI:** clicking a bar opens the right filtered list; each panel shows its own loading, empty and error state; the print layout fits on two A4 pages.
10. `pnpm typecheck && pnpm lint && pnpm test` passes and the UI-GUIDE checklist passes for `/reports`.

## Out of scope

Scheduled email reports, targets/quotas, forecasting, and custom report builders. Note them as follow-ups if requested.
