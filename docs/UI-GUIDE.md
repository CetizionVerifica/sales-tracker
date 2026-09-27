# UI Guide — Sales Tracker

Every screen in this app follows this guide. Read it before building or changing any UI.
If a screen needs something this guide doesn't cover, follow the closest existing pattern and add the new pattern here.

**Design intent:** a calm, dense, professional workspace for people who live in it all day. Quiet neutrals, clear hierarchy, data first. Two things carry the identity:

1. **The pipeline ramp** — the five stages (Enquiry → Quotation → Project → PO → Invoice) always use the same blue ramp, light to deep, so position in the pipeline is visible at a glance.
2. **The saffron "needs attention" mark** — used _only_ for things due today or overdue. Nothing else in the app is saffron.

Everything else stays restrained: no gradients, no decorative shadows, no illustrations.

---

## 1. Stack for UI

- Tailwind CSS + **shadcn/ui** components (install with the shadcn CLI into `packages/ui` or `apps/web/components/ui`).
- Icons: **lucide-react**, 16px in tables/buttons, 18px in navigation. Stroke width 1.75.
- Tables: **TanStack Table** wrapped in one shared `<DataTable>` component.
- Charts: **Recharts** wrapped in shared chart components that read colours from CSS variables.
- Forms: React Hook Form + Zod + shadcn `<Form>`.
- Toasts: shadcn **Sonner**.
- Command palette: shadcn `<Command>` on ⌘K / Ctrl+K.
- Font: **IBM Plex Sans** via `next/font/google` (weights 400, 500, 600). No second typeface.

Never hand-roll a component that exists in shadcn/ui. Never import a second UI library.

---

## 2. Design tokens

Put these in `apps/web/app/globals.css`. Components use tokens only — **no raw hex values or arbitrary Tailwind colours (`bg-blue-500`) in components.**

```css
:root {
  /* Neutrals */
  --background: #f5f6f8; /* app canvas */
  --foreground: #1b2533; /* primary text */
  --card: #ffffff; /* panels, tables */
  --card-foreground: #1b2533;
  --popover: #ffffff;
  --popover-foreground: #1b2533;
  --muted: #eef0f3; /* table header, subtle fills */
  --muted-foreground: #5b6675; /* secondary text */
  --border: #dde1e7;
  --input: #d2d7de;

  /* Brand */
  --primary: #1e3f66; /* primary buttons, active nav, links */
  --primary-foreground: #ffffff;
  --secondary: #e8edf3;
  --secondary-foreground: #1e3f66;
  --accent: #e8edf3; /* hover fills */
  --accent-foreground: #1b2533;
  --ring: #3a6ea5;

  /* Attention (due today / overdue only) */
  --attention: #d99a1e;
  --attention-soft: #fbf1dc;
  --attention-foreground: #6b4a08;

  /* Semantic status */
  --success: #2e7d4f;
  --success-soft: #e4f2e9;
  --warning: #a86a12;
  --warning-soft: #f8eedc;
  --destructive: #b42318;
  --destructive-soft: #fbe7e5;
  --destructive-foreground: #ffffff;
  --neutral: #6b7686;
  --neutral-soft: #eef0f3;

  /* Pipeline ramp (light → deep = earlier → later) */
  --stage-enquiry: #8fa8c8;
  --stage-quotation: #5f86b3;
  --stage-project: #3a6a9e;
  --stage-po: #245184;
  --stage-invoice: #143a63;

  /* Charts (non-pipeline series) */
  --chart-1: #245184;
  --chart-2: #2e7d4f;
  --chart-3: #d99a1e;
  --chart-4: #8fa8c8;
  --chart-5: #6b7686;

  /* Sidebar */
  --sidebar: #ffffff;
  --sidebar-foreground: #1b2533;
  --sidebar-accent: #eef2f7;
  --sidebar-border: #dde1e7;

  /* Shape */
  --radius: 10px; /* panels, cards, dialogs */
  --radius-control: 6px; /* inputs, buttons, badges */
}

.dark {
  --background: #10161f;
  --foreground: #e6eaf0;
  --card: #161e29;
  --card-foreground: #e6eaf0;
  --popover: #1b2431;
  --popover-foreground: #e6eaf0;
  --muted: #1e2835;
  --muted-foreground: #97a2b1;
  --border: #2a3544;
  --input: #334051;
  --primary: #7fa6d4;
  --primary-foreground: #0e1620;
  --secondary: #1f2b3a;
  --secondary-foreground: #c9d6e6;
  --accent: #1f2b3a;
  --accent-foreground: #e6eaf0;
  --ring: #7fa6d4;
  --attention: #e8b040;
  --attention-soft: #3a2e14;
  --attention-foreground: #f4d58f;
  --success: #5bb582;
  --success-soft: #16301f;
  --warning: #d9a04a;
  --warning-soft: #33280f;
  --destructive: #e0675c;
  --destructive-soft: #3a1714;
  --neutral: #97a2b1;
  --neutral-soft: #1e2835;
  --sidebar: #131a24;
  --sidebar-foreground: #e6eaf0;
  --sidebar-accent: #1f2b3a;
  --sidebar-border: #2a3544;
}
```

Light mode is the default. Dark mode is a toggle in the user menu (next-themes); every screen must work in both.

### Typography

| Role          | Size / line-height | Weight | Use                                     |
| ------------- | ------------------ | ------ | --------------------------------------- |
| Page title    | 22px / 28px        | 600    | One per page, in the page header        |
| Section title | 16px / 24px        | 600    | Panel and card headings                 |
| Body          | 14px / 20px        | 400    | Default UI text, table cells            |
| Small         | 13px / 18px        | 400    | Secondary text, helper text, table meta |
| Micro         | 12px / 16px        | 500    | Badges, chart axis labels               |
| KPI value     | 28px / 34px        | 600    | Dashboard metric numbers only           |

- **All numbers use tabular figures** (`font-variant-numeric: tabular-nums` — add a `.num` utility) and are right-aligned in tables.
- Sentence case everywhere: titles, buttons, tabs, column headers. **No ALL CAPS labels.**
- Don't highlight a single word in a heading with colour or weight.

### Spacing, shape, elevation

- 4px base grid. Common steps: 4, 8, 12, 16, 24, 32.
- Page padding 24px (16px on mobile). Gap between panels 16px.
- Panels: `bg-card`, `border`, `rounded-[var(--radius)]`, **no shadow**.
- Controls (inputs, buttons, badges): `rounded-[var(--radius-control)]`.
- Shadows only on floating layers: popovers, dropdowns, dialogs, sheets, toasts.
- Motion: 150ms ease-out for opening/closing layers and expanding rows. No entrance animations on page load. Respect `prefers-reduced-motion`.

---

## 3. App shell

```
┌──────────────┬───────────────────────────────────────────────────────────┐
│  Logo        │  [⌘K Search…]                  [+ New ▾]  [🔔]  [Avatar ▾] │  ← top bar 56px
│              ├───────────────────────────────────────────────────────────┤
│  My today  3 │  Page title                                  [Secondary] [Primary]
│  Dashboard   │  One-line description of the page (muted)                 │  ← page header
│              │                                                           │
│  PIPELINE    │  [Filter bar: search · status · owner · date range]  [⋯]  │
│  Enquiries   │  ┌─────────────────────────────────────────────────────┐  │
│  Quotations  │  │                                                     │  │
│  Projects    │  │                 Page content                        │  │
│  POs         │  │                                                     │  │
│  Invoices    │  └─────────────────────────────────────────────────────┘  │
│  Clients     │                                                           │
│              │                                                           │
│  ADMIN       │                                                           │
│  Users       │                                                           │
│  Masters     │                                                           │
│  Settings    │                                                           │
│  Audit log   │                                                           │
│  MCP access  │                                                           │
└──────────────┴───────────────────────────────────────────────────────────┘
  sidebar 240px (collapses to 64px icons; off-canvas sheet below 1024px)
```

- Build with shadcn **Sidebar**. Group labels ("Pipeline", "Admin") are 12px, 500 weight, muted, **sentence case** (the caps in the sketch are just for the diagram).
- Each pipeline nav item has a 3px left bar in its stage colour when active.
- "My today" shows a count badge in `--attention-soft` / `--attention-foreground` when items are due.
- The Admin group renders only for `ADMIN`. Hide what users can't use; don't show disabled links.
- **+ New** dropdown: Enquiry, Follow-up, Quotation, Project, PO, Invoice (filtered by role).
- Top bar search opens the ⌘K command palette: jump to any record by number or client name, and run actions ("New enquiry", "Log follow-up").
- Breadcrumbs appear on detail pages only, above the page title: `Enquiries / ENQ-0142`.
- Content max width: none for tables and dashboards; 880px for forms and settings.

One shell component (`<AppShell>`) and one page header component (`<PageHeader title description actions />`). Every page uses both.

---

## 4. Page templates

Every page is one of these five. Don't invent a new layout.

### 4.1 List page (Enquiries, Quotations, Projects, POs, Invoices, Clients, Users)

```
PageHeader: "Enquiries" · "Track every enquiry from first contact to conversion"   [Export] [New enquiry]
Summary strip: [In progress 24] [Converted this month 9] [Lost this month 3]   ← clickable filter chips
Filter bar:   [Search client or number…] [Status ▾] [Owner ▾] [Sector ▾] [Received: This month ▾]  [Clear]
DataTable
Pagination:   "Showing 1–25 of 312"                    [25 ▾]  ‹ 1 2 3 … ›
```

- Filters sync to the URL query string so views are shareable and survive refresh.
- Summary strip: up to 4 compact stat chips, not big cards.
- Row click opens the detail page. Row actions live in a trailing `⋯` menu.
- Bulk actions appear in a bar above the table only when rows are selected.

### 4.2 Detail page (a single enquiry, quotation, project, PO, invoice, client)

```
Breadcrumb: Quotations / QUO-0087
PageHeader: "Acme Pharma — Stability testing"   [Status badge]           [Log follow-up] [Edit] [⋯]
Pipeline strip: ● Enquiry ─── ● Quotation ─── ○ Project ─── ○ PO ─── ○ Invoice
┌───────────────────────────────────────────┬──────────────────────────┐
│ Tabs: Overview | Timeline | Documents | Audit │  Side panel             │
│                                           │  Key facts (label/value)  │
│ Overview: sections in a 2-col field grid  │  Owner, dates, amount     │
│                                           │  Next follow-up (saffron  │
│                                           │  if today/overdue)        │
│                                           │  Linked records           │
└───────────────────────────────────────────┴──────────────────────────┘
      main: flexible                              side: 320px (stacks below on mobile)
```

- **Pipeline strip** (`<PipelineStrip current="quotation" links={…} />`) appears on every pipeline record. Completed stages are filled dots in their stage colour and link to that record; future stages are hollow grey. This is the app's signature element — keep it identical everywhere.
- Tabs are the same four on every pipeline record, in this order. Clients get: Overview, Pipeline, Timeline, Documents.
- Read-only fields display as label (13px muted) over value (14px). Don't show disabled inputs for reading.

### 4.3 Form (create / edit)

- **Create and edit open in a right-side Sheet (560px)** for Enquiry, Follow-up, Quotation, Client, User. Larger forms (Project, PO, Invoice with document upload) use a full page at max 880px.
- Fields in a single column; pair short related fields (dates, amount + currency) in two columns.
- Group with section titles, not boxes inside boxes.
- Footer: `[Cancel]` left of `[Save enquiry]`, sticky at the bottom of the sheet/page. Primary button names the action + object.
- Inherited values (e.g. client on a quotation from its enquiry) are pre-filled and marked with small muted helper text: "From ENQ-0142".
- Validation: inline under the field on blur and on submit; scroll to and focus the first error. Server errors appear as a destructive Alert at the top of the form.
- Unsaved changes: confirm before closing the sheet.

### 4.4 Dashboard (Dashboard, My today)

```
PageHeader: "Dashboard"                                 [Period: This quarter ▾] [Owner: All ▾]
KPI row (4):  Open pipeline value | Conversion rate | Won this quarter | Overdue receivables
Row:  [Pipeline funnel — 2/3 width]            [Receivables ageing — 1/3]
Row:  [Conversion by sector — 1/2]             [Quoted vs won by month — 1/2]
Row:  [Top clients by revenue — table, full width]
```

- 12-column grid, 16px gaps. Panels are `<Panel title description actions>`.
- KPI tile: label (13px muted), value (28px, tabular), delta vs previous period (13px, success/destructive colour with a ▲/▼ glyph). Maximum 4 per row. No icons in circles, no sparkline decoration unless it shows real data.
- The funnel uses the pipeline ramp colours. Other charts use `--chart-*`.
- Charts: horizontal gridlines only, 1px `--border`; no chart borders; axis labels 12px muted; tooltip in a popover style; legend only when there's more than one series.
- Money on axes is abbreviated in Indian style: ₹12.5L, ₹1.2Cr.

**My today** is a task list, not charts:

```
PageHeader: "My today" · "Wednesday, 7 October"
Sections (each a Panel with a count):  Overdue (saffron) · Due today (saffron) · Coming up (next 7 days)
Each row: [type icon] Client — what to do         due date     [Log follow-up] [Open]
```

- Row types: follow-up due, quotation awaiting reply, invoice due, invoice overdue, stale enquiry.
- Completing an action (e.g. logging a follow-up) removes the row with a short collapse animation and a toast.

### 4.5 Document review (PO / invoice extraction)

```
┌─────────────────────────────┬──────────────────────────────┐
│  Document preview (PDF/img)  │  Extracted fields (form)      │
│  zoom, page nav              │  each field shows confidence: │
│                              │  high = normal                │
│                              │  low  = warning-soft bg +     │
│                              │         "Check this value"    │
│                              │  [Discard] [Confirm and save] │
└─────────────────────────────┴──────────────────────────────┘
```

- Split 50/50 on desktop, stacked on mobile.
- While extraction runs: preview visible, form shows skeletons and "Reading document…".
- Mismatches (e.g. invoice client ≠ PO client) show a warning Alert above the form.

---

## 5. Components

### DataTable rules

- Header row: `bg-muted`, 13px, 500 weight, sentence case. Sticky on scroll.
- Row height 44px (comfortable) with a density toggle for 36px (compact). Zebra striping off; hover `bg-accent`.
- Column order: identifier (e.g. `ENQ-0142`, 500 weight) → client → key descriptors → status → money → dates → owner avatar → `⋯`.
- Money and numbers right-aligned, tabular. Text left-aligned. Status centred-left as a badge.
- Long text truncates with a tooltip showing the full value.
- Sortable columns show the sort icon on hover and when active.
- Column visibility menu in the table toolbar; remember choice per user in localStorage.

### Status badges

One `<StatusBadge entity status />` component. Badges are soft fill + strong text, 12px, `--radius-control`, with a 6px dot.

| Entity      | Status                                                      | Style                                                              |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Enquiry     | In progress                                                 | neutral                                                            |
| Enquiry     | Converted                                                   | success                                                            |
| Enquiry     | Lost                                                        | destructive                                                        |
| Quotation   | Sent                                                        | neutral                                                            |
| Quotation   | Under negotiation                                           | warning                                                            |
| Quotation   | PO received                                                 | success                                                            |
| Project     | Not started / In progress / On hold / Completed / Cancelled | neutral / primary (secondary bg) / warning / success / destructive |
| PO, Invoice | Pending                                                     | neutral                                                            |
| PO, Invoice | Paid                                                        | success                                                            |
| PO, Invoice | Overdue                                                     | **attention** (saffron)                                            |

Status labels are sentence case ("Under negotiation"), never enum strings (`UNDER_NEGOTIATION`).

### Other components

- **Buttons:** one primary per view region. Secondary = outline. Destructive only for delete/lose, always behind a confirm dialog that names the record ("Delete ENQ-0142?").
- **Timeline** (`<Timeline items />`): vertical line, 8px dot per event coloured by event type (follow-up = primary, status change = stage colour, document = neutral), date in muted text on the left at ≥768px.
- **Money** (`<Money amountMinor currency />`): `Intl.NumberFormat('en-IN', { style: 'currency', currency })`. INR shows Indian grouping (₹12,50,000). Non-INR values show the INR equivalent in muted text beneath when available.
- **Dates:** `7 Oct 2026` in tables and fields; relative ("in 2 days", "3 days overdue") next to follow-up and due dates. Timezone Asia/Kolkata.
- **Avatars:** initials on `--secondary`, 24px in tables, 32px in headers.
- **Record identifiers:** prefixed and zero-padded: `ENQ-0142`, `QUO-0087`, `PRJ-0031`, PO uses the client's PO number, invoices use the extracted invoice number.

---

## 6. States

Every data view handles all four states.

- **Loading:** skeletons shaped like the final content (table rows, KPI tiles). No full-page spinners. Buttons show an inline spinner and keep their label while submitting.
- **Empty:** one sentence saying what goes here + the action to fill it. "No enquiries yet. Add the first one when a client gets in touch." `[New enquiry]`. Filtered-empty says "No enquiries match these filters." `[Clear filters]`.
- **Error:** say what failed and what to do. "Couldn't load invoices. Check your connection and try again." `[Retry]`. No apologies, no raw error text (log it instead).
- **No permission:** "You don't have access to this page. Ask an admin if you need it." Never a blank screen.

Toasts confirm completed actions using the same verb as the button: button "Save quotation" → toast "Quotation saved". Destructive actions offer Undo where feasible.

---

## 7. Writing

- Plain words from the user's world: "Log follow-up", not "Create FollowUp entity".
- Buttons = verb + object: "New enquiry", "Mark as lost", "Confirm and save".
- The same action has the same name everywhere (nav, button, toast, audit log).
- Help text only where a field is genuinely unclear; one short sentence.

---

## 8. Responsive and accessibility

- Breakpoints: mobile < 768px, tablet 768–1279px, desktop ≥ 1280px.
- Below 1024px the sidebar becomes a sheet opened from a menu button in the top bar.
- Below 768px, list pages switch from tables to stacked cards (identifier, client, status, amount, date), and detail side panels move above the tabs.
- Colour contrast ≥ 4.5:1 for text. Status is never shown by colour alone — badges always have text.
- Visible focus ring (`--ring`, 2px, offset 2px) on every interactive element. Full keyboard navigation, including tables and the command palette.
- Every icon-only button has an `aria-label` and a tooltip.

---

## 9. Where shared UI lives

```
apps/web/components/
  layout/     AppShell, Sidebar, TopBar, PageHeader, Breadcrumbs
  data/       DataTable, FilterBar, SummaryStrip, Pagination
  pipeline/   PipelineStrip, StatusBadge, Timeline
  display/    Money, DateDisplay, RelativeDue, UserAvatar, FieldGrid
  charts/     KpiTile, Panel, FunnelChart, BarChart, LineChart, AgeingChart
  feedback/   EmptyState, ErrorState, NoAccess, ConfirmDialog
  ui/         shadcn components (don't edit except via the CLI or for token wiring)
```

Build the shell and these shared components in **M0/M1** before any feature screen, and add a `/dev/ui` page (dev only) that renders every shared component in every state so they can be checked in one place.

---

## 10. UI checklist (run before finishing any screen)

- [ ] Uses `AppShell` and `PageHeader`; matches one of the five page templates.
- [ ] Only tokens — no raw hex, no arbitrary Tailwind colours.
- [ ] Saffron used only for due-today / overdue.
- [ ] Pipeline records show the `PipelineStrip` and the standard tabs.
- [ ] Numbers tabular and right-aligned; money via `<Money>`; dates via `<DateDisplay>`.
- [ ] Loading, empty, error and no-permission states implemented.
- [ ] Sentence case everywhere; no enum strings visible.
- [ ] Works in light and dark mode, at 375px, 768px and 1440px widths.
- [ ] Keyboard-navigable with visible focus; icon buttons labelled.
- [ ] Button label, toast and audit wording use the same verb.

---

## 11. Patterns added during the build

Added when the guide was first applied (branch `ui-guide`), as the guide's introduction asks for new patterns.

- **Form sheets open from the URL.** `?new=1` on a list and `?edit=1` on a detail page open that page's form sheet; quotations open with `?newQuotation=1` on their enquiry. The old `/new` and `/edit` routes redirect there, so `+ New`, ⌘K and old links all land on the sheet. `<SheetLauncher>` wires the button and the param; `<FormSheet>` is the sheet (sticky footer, discard confirmation).
- **Row and page menus.** A row's `⋯` is `<RowActions>`; a detail page's `⋯` is `<RecordMenu>`, where every item sits behind a confirmation that names the record. Destructive items come last, after a separator.
- **Tabs live in the URL** (`?tab=timeline`), so a tab survives refresh and can be linked. Filters inside a tab (the client timeline) keep the tab.
- **Loading and error at route level.** `app/(app)/loading.tsx` shows skeletons; `app/(app)/error.tsx` shows `<ErrorState>` with Retry.
- **Lists switch to cards with CSS** (`md:hidden` / `hidden md:block`), not JavaScript, so a phone never flashes the wide table.

Deviations, and why:

- **Someone else's record shows the 404 page, not No access** (M4 Decision 7: it must not reveal that the record exists). `<NoAccess>` is for whole areas a role can't use, such as Admin.
- **Warning badges use foreground text.** `--warning` on `--warning-soft` is about 3.9:1, below the 4.5:1 rule, so the dot carries the colour.
- **IBM Plex Sans is self-hosted** (`app/fonts`, SIL OFL): `next/font/google` fails under this Next version's Turbopack when more than one weight is requested.
- **The Timeline component stays in `components/timeline/`**, next to its follow-up sheet and actions, rather than `pipeline/`.
- **Not built yet, because the features don't exist:** the notification bell (reminders), Export (M12), the INR equivalent under non-INR money (M12 rates), and My today and Dashboard in the sidebar (M11, M12).
