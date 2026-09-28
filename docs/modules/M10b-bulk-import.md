# M10b — Bulk import (any spreadsheet layout, no MCP)

**Depends on:** M1 Auth/RBAC, M2 Audit log, M3 Admin (masters), M4–M10 (all pipeline entities), M7 (Cloudinary upload + worker pattern), M11 My today, M12 Dashboards, M12b Sales reports.
**Built after M12b.** M11, M12 and M12b already exist, so this module must fit around them: reuse their schema, keep their numbers correct, and not flood My today with historical items. See "Fitting with modules already built" below.
**Follow:** `CLAUDE.md`, `docs/UI-GUIDE.md`.
**No MCP server is needed.** Everything runs inside the web app and worker. The import engine lives in `packages/core/import`, so an MCP or REST adapter can reuse it later without changes.

## Goal

Let users upload a spreadsheet in **whatever layout they already keep**, then map, check and fix it in the app, and load it safely. Examples: last year's enquiry register, a salesperson's personal tracker, an accounts team's invoice list, or one big sheet mixing enquiries, quotations, POs and invoices in each row.

"Any format" means:

| Variation       | Examples                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File types      | `.xlsx`, `.xlsm` (macros ignored), `.xls`, `.ods`, `.csv`, `.tsv`, `.txt` (delimited)                                                                                                                                                                                        |
| Sheet structure | Several sheets; title/logo rows above the header; header not in row 1; two-row or merged headers; blank rows; subtotal/total rows; notes below the data                                                                                                                      |
| Column naming   | Any names in any order: "Client", "Customer Name", "Party", "Company"                                                                                                                                                                                                        |
| Values          | Dates as `12/03/2025`, `12-Mar-25`, `March 12 2025` or Excel serials; amounts as `12,50,000`, `₹12.5 L`, `1.2 Cr`, `USD 5,000`, or a separate currency column; statuses in the user's own words ("Won", "Dropped", "Negotiation"); several services in one cell ("ESG, HSE") |
| Content         | One entity per sheet, **or a combined register** where one row covers enquiry → quotation → PO → invoice                                                                                                                                                                     |
| CSV quirks      | Comma/semicolon/tab delimiters, quoted fields, UTF-8 or Windows-1252 encoding, BOM                                                                                                                                                                                           |

The design principle: **AI suggests the mapping once per sheet; code transforms every row deterministically; the user confirms before anything is saved.** AI never processes rows one by one and never writes to the database.

---

## User flow

A six-step wizard at `/imports/new`, with a step indicator at the top (UI-GUIDE: full-width page; the stepper sits under the page header).

```
1 Upload → 2 Sheets → 3 Columns → 4 Values → 5 Review → 6 Import
```

**1. Upload**

- Drag-and-drop or browse. Max 20 MB, 50,000 rows per file.
- Optional choice of what the file contains: _Let the app detect it_ (default), Clients, Enquiries, Quotations, Projects, Purchase orders, Invoices, Follow-ups, or Combined pipeline register.
- Import options: **Mode** (Add new records only / Add new and update existing); **Historical data** (allow final statuses like Lost or Paid directly; on by default for files with dates older than 30 days); **Create missing clients** (ask / yes / no); **Default owner** (sales users: themselves, fixed).
- The file goes to Cloudinary (raw, private), then a worker job parses it. The page shows progress: "Reading file…", "Finding tables…", "Suggesting column mapping…".

**2. Sheets and structure**

- List every sheet with its row count and the detected table: a preview grid (first 15 rows) highlighting the detected **header row(s)**, **data range**, and **skipped rows** (titles, blanks, totals) in muted strikethrough.
- For each sheet, the user can: include or exclude it; change the header row (click a row); mark a two-row header; set the entity type; adjust the first and last data rows.
- If the file has the same layout across sheets (e.g. one sheet per month), offer "Treat all these sheets as one table".

**3. Columns**

- A two-column mapping table: **file column** (with 3 sample values) → **app field** (dropdown grouped by entity), plus a confidence indicator (high / check) and a transform setting where relevant:
  - Dates: detected format (`DD/MM/YYYY` default for India, `MM/DD/YYYY`, `DD-MMM-YY`, Excel serial). Ambiguous columns (all days ≤ 12) are flagged, and the user must pick a format.
  - Amounts: unit (rupees / thousands / lakhs / crores) and currency (fixed, from a column, or parsed from the value).
  - Multi-value cells: separator for services (`,`, `/`, `;`, `&`, new line).
  - Combine or split: e.g. two columns "First name" + "Last name" → contact name; "Invoice No / Date" → split by `/`.
- Unmapped columns are ignored; they can optionally be saved into a record's notes as `Column: value`.
- Required fields that are unmapped block the step, with a message naming them.
- A live preview on the right shows five rows as they will be imported.
- **Saved mappings:** if the file's header fingerprint matches a saved mapping, it's applied automatically and AI is skipped ("Using saved mapping 'Accounts invoice sheet'"). After a successful import, offer "Save this mapping for next time".

**4. Values**

For each mapped field with a fixed set of values, list the **distinct values found** in the file with counts, and map each one:

| Field                    | File value → App value                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Enquiry/quotation status | "Won" → PO received · "Dropped" → Lost · "Negotiation" → Under negotiation · "Follow up" → Sent |
| Sector                   | "Pharma" → Pharmaceutical · "Steel" → Metal industry · "Agri" → Agriculture                     |
| Service                  | "Eco Vadis" → EcoVadis · "E.S.I.A" → ESIA                                                       |
| Owner / PM               | "Rahul" → rahul.sharma@…                                                                        |
| Client                   | "Sun Pharma", "SUN PHARMACEUTICAL" → Sun Pharmaceutical Industries Ltd (existing)               |

- Values are pre-matched with this order: saved aliases → exact match → fuzzy match → AI suggestion. Each is marked _auto_ or _needs check_.
- Unmatched values offer: **map to existing**, **create new** (masters and clients; admin only for sectors/services), or **leave blank** (only if the field is optional).
- Client matching uses `pg_trgm` against existing clients **and** groups spelling variants within the file, so "Sun Pharma" and "Sun Pharma Ltd" become one client.
- "Remember these matches" (default on) saves them as `SectorAlias`, `ServiceAlias`, `ClientAlias` and status aliases for future imports.

**5. Review**

- Summary: rows to create, update and skip, and rows with errors, warnings and duplicates. For a combined register, show counts per entity: "412 enquiries, 318 quotations, 146 POs, 201 invoices, 37 new clients".
- A grid of all rows with a status column and filter chips (Errors · Warnings · Duplicates · Ready). Each error cell is highlighted with the reason on hover.
- **Fix in place:** edit a cell to correct it and re-validate that row immediately; exclude rows; bulk actions ("Exclude all duplicates", "Set missing owner to…").
- **Download error report:** the original rows with an added "Import issues" column, as `.xlsx`, so users can fix the file in Excel and re-upload.
- The **Import** button stays disabled while errors remain (excluded rows don't count).

**6. Import**

- The confirm dialog restates the counts: "Import 1,077 records from Enquiry register FY24.xlsx? You can undo this for 7 days."
- The commit runs as a worker job with a progress bar, **all-or-nothing** in one database transaction.
- The result page shows counts per entity, links to the imported records (list pages filtered by `importBatchId`), and an **Undo import** button.

**Imports history** at `/imports`: a table of batches (file, entity, user, date, rows, status: Draft, Ready, Importing, Imported, Failed, Undone, Expired) with resume for drafts and undo for recent imports. Drafts expire after 7 days. Admins see everyone's imports; sales users see their own.

---

## Pipeline (how it works)

```
Upload ─► Parse ─► Detect structure ─► Suggest mapping (AI, samples only) ─► User maps columns & values
       ─► Transform all rows (code) ─► Resolve & validate (staging) ─► User reviews & fixes ─► Commit (transaction)
```

```
packages/core/import/
  parse/
    read-workbook.ts     SheetJS → normalised Sheet { name, cells[][], merges }
    csv.ts               delimiter + encoding detection, BOM handling
    unmerge.ts           fill merged cells so headers and grouped rows resolve
  detect/
    table.ts             header row, multi-row header, data range, skip rows (heuristics)
    fingerprint.ts       normalised header hash for saved mappings
  suggest/
    field-catalog.ts     every importable field: name, entity, type, required, synonyms, examples
    heuristic.ts         synonym + fuzzy header matching (works with AI turned off)
    ai-mapping.ts        Anthropic call → MappingSuggestion (Zod-validated)
  transform/
    dates.ts, money.ts, split.ts, text.ts
  resolve/
    clients.ts, masters.ts, people.ts, parents.ts, value-aliases.ts
  combined/
    split-row.ts         one combined-register row → linked entity drafts
  validate/
    rows.ts              Zod schemas + status-machine field rules + natural keys
  commit/
    commit-batch.ts      single transaction, audit source 'import', batchId on every record
    rollback-batch.ts
  service.ts             public API used by server actions and worker jobs
```

### Parsing

- **SheetJS (`xlsx`)** reads xlsx/xlsm/xls/ods/csv. Install it from the SheetJS CDN tarball, as the public npm registry copy is outdated; check SheetJS's current install instructions when adding the dependency.
- Read **cached cell values only**: never evaluate formulas and never run macros. Keep Excel date cells as dates, and convert Excel serial numbers with the workbook's 1900/1904 date system.
- Protection limits: reject if the uncompressed size exceeds 200 MB (zip bomb guard) or if parsing takes over 60 seconds; verify file type by magic bytes, not extension. Password-protected files get a clear error: "This file is password-protected. Remove the password in Excel and upload again."
- The parsed result is stored as JSON on the batch (not re-parsed per step).

### Structure detection (code, before AI)

- **Header row:** score the first 30 rows; a header row has many non-empty, mostly text, mostly unique cells, followed by rows of consistent types. Support two-row headers by joining parent and child labels ("Invoice › Number").
- **Data range:** from after the header to the last row before a run of 3+ blank rows or a notes block.
- **Skip rows:** blank rows, repeated header rows (common in printed exports), and total rows (a cell matching "total|grand total|sum" with numeric sums).
- **Merged cells:** fill values down/right so grouped rows (e.g. client name merged across 5 rows) apply to each row.

### AI mapping suggestion

- One Anthropic API call **per sheet** (not per row), made by the worker.
- **Input:** sheet name, detected headers, up to **20 sample rows** (after structure detection), distinct values (up to 50) of low-cardinality columns, the field catalogue, the master lists (sector/service names), and the chosen entity type if given.
- **Output** (structured JSON, validated by a Zod `MappingSuggestion` schema):
  - `entity`: one of the entities or `combined`.
  - `columns[]`: `{ sourceColumn, targetField | null, confidence (0–1), transform: { dateFormat?, amountUnit?, currency?, separator? }, reason }`.
  - `valueMappings[]`: `{ field, sourceValue, targetValue | null, confidence }`.
  - `warnings[]`, e.g. "Amounts appear to be in lakhs".
- Model id comes from env `ANTHROPIC_IMPORT_MODEL`; temperature 0; timeout 30 seconds.
- If the call fails, times out or returns invalid JSON: fall back to `heuristic.ts`, and tell the user "Automatic mapping unavailable. Suggestions are based on column names only."
- **Privacy:** only headers, samples and distinct values are sent, never the whole file. Admin setting `importAiAssist` (on/off); when off, only heuristics are used. The settings page states what is sent.
- AI output is only ever a **suggestion shown to the user**. It's never applied without passing through the Columns and Values steps. A saved mapping reused later still shows those steps pre-filled for a quick confirm.

### Transform (deterministic code)

- **Dates** → ISO `YYYY-MM-DD` using the confirmed format. Values that don't parse become errors, never guesses.
- **Money** → `amountMinor` (`BigInt`) + currency. It parses Indian and international grouping, `₹`/`Rs`/`INR`/`USD`/`$`/`€` symbols and codes, `L`/`lakh`/`lac`, `Cr`/`crore` and `K` suffixes, and the column unit multiplier. Negative or zero amounts are warnings. Non-INR values need an FX rate: from a mapped column, else the settings default (warning).
- **Text:** trim, collapse whitespace, normalise Unicode; emails lower-cased; GSTIN upper-cased and checksum-validated (invalid = warning, value dropped).
- **Split** multi-value cells by the confirmed separator; trim; de-duplicate.

### Combined pipeline register

When a row holds several stages, `split-row.ts` creates linked drafts in dependency order:

```
Client (resolve or create)
  └─ Enquiry        always (needs client + received date or proposal date)
      └─ Quotation  if any quotation field is present (amount, quotation no/date, status)
          └─ Project + PurchaseOrder   if a PO number or PO amount is present
              └─ Invoice               if an invoice number is present (one per row; repeated
                                       PO numbers on several rows attach several invoices to one PO)
```

- One status column may drive several stages via value mappings (e.g. "Won" → enquiry `CONVERTED` + quotation `PO_RECEIVED`; "Lost" → enquiry `LOST`; "Paid" → invoice `PAID`).
- Auto-created projects: name `<Client> — <Service(s)>`, manager = the mapped PM column or the import's default PM, status `IN_PROGRESS` (or `COMPLETED` if all invoices are paid and historical mode is on).
- Rows sharing a PO number (same client) collapse to one PO; rows sharing an enquiry `externalRef` or quotation number collapse likewise.
- A single-service PO gets one `PurchaseOrderLine`; a multi-service PO gets an equal split flagged `allocationEstimated` (see M12b).

### Resolve and validate (staging)

Each staged row stores: original cells, transformed values, resolved references, and a status: **ready**, **warning**, **error**, **duplicate** or **excluded**, with messages `{ field, code, message }`.

- **References:** clients (alias → GSTIN → exact name → fuzzy ≥ 0.9 auto, 0.75–0.9 "needs check", lower = unmatched), masters (alias → exact → fuzzy), people (email → name), parents (by number within the file first, then the database).
- **Natural keys** for duplicates and updates: Client (GSTIN, else normalised name), Enquiry (`externalRef`, else a _possible_ duplicate on client + received date + service, shown as a warning), Quotation (number), PO (client + PO number), Invoice (invoice number). Also detect duplicates **within the file**.
- **Rules:** the shared Zod schemas plus the status-machine field rules from `CLAUDE.md`. Historical mode allows final statuses directly but still requires their fields (`PAID` → `paidAt`, `LOST` → `lostReason`; a missing reason defaults to "Imported — reason not recorded" with a warning). Without historical mode, imported records start in their initial status only.
- **RBAC:** sales users can only import records they will own (owner forced to themselves; other owner values are errors) and can't create sectors or services; project managers can import follow-ups, POs and invoices for assigned projects only; admins can import anything.
- Validation runs in the worker, in chunks of 1,000 rows, with progress reported to the page.

### Commit and undo

- One transaction for the whole batch; entities inserted in dependency order; derived PO statuses recalculated at the end; invoice overdue status computed from due dates.
- Every created or updated record gets `importBatchId`, and the audit log records source `import`, the batch id and the acting user. Updates store before/after as usual.
- Transaction timeout sized for 20,000 rows. If it fails, nothing is saved and the batch returns to **Ready** with the error shown.
- **Undo** (within 7 days; admin, or the user who imported if nothing has changed since): soft-deletes created records and restores updated records to their `before` values, in reverse dependency order, audited. Undo is refused for records edited after the import, listing them, unless an admin chooses "Undo the rest".

---

## Fitting with modules already built (M11, M12, M12b)

Before planning, read the existing code for M11, M12 and M12b (and `docs/modules/M12b-sales-reports.md`). Reuse what exists; don't recreate it.

**Reuse from M12b (do not re-add)**

- `PurchaseOrderLine`: imported POs create lines through the same core service M12b added, including the equal-split rule and `allocationEstimated`.
- `amountInrMinor` and `fxRate` on Quotation, PurchaseOrder, PurchaseOrderLine and Invoice: the importer sets them through the same core function M12b uses at save time, never with its own conversion code.
- `Sector.isOther` and the existing report indexes.

**Reports and dashboards (M12, M12b)**

- Commit and undo must **invalidate the report cache** through the same mechanism M12b uses on enquiry, PO and invoice writes, so reports update immediately.
- Imported records must satisfy every M12b metric definition without special cases. The report queries must not need to know a record was imported. If a definition can't be met from imported data (e.g. a PO with no `receivedDate`), make it a row error, not a report exception.
- Imports will legitimately change historical report figures (e.g. R5 "new customer" depends on each client's first-ever enquiry). The import result page states this: "Reports for periods covered by this import now include the imported data."
- Add a regression test: import `combined-register-fy24.xlsx`, then assert R1–R6 match the fixture's expected numbers.

**My today and reminders (M11)**

Historical data would otherwise fill My today with hundreds of old items and trigger reminder emails.

- **Import option: "Past follow-up dates"** (shown when historical mode is on and any open quotation or follow-up has a `nextFollowUpDate` before today):
  - _Keep as is_: they appear as overdue in My today.
  - _Move to a date_: set all past next-follow-up dates on **open** records to a chosen date (default: 7 days from today), noted in the audit log.
  - _Clear them_: only for records where it's allowed; open quotations require a date, so they fall back to _Move_.
    The Review step shows how many items each choice will add to each owner's My today.
- **No reminders for the import itself:** suppress notifications and reminder emails caused by the commit (pass `ctx.source = 'import'`; the reminder jobs skip events with that source). The next scheduled reminder run treats imported items like any other.
- Unpaid imported invoices past their due date are set to `OVERDUE` at commit, matching the nightly job, so M11 and the receivables ageing in M12 are correct immediately.

**Existing data**

- If an earlier ad hoc import or seed loaded data without `importBatchId`, leave it alone; undo only ever touches records carrying the batch's id.

## Schema changes

Only add what doesn't exist yet. Check the current Prisma schema first; the M12b additions above are already there.

- `ImportBatch`: id, fileName, fileStorageKey, fileSize, options (JSON), parsed (JSON), sheetConfig (JSON), mapping (JSON), status (`uploaded | parsing | mapping | validating | ready | committing | committed | failed | undone | expired`), counts (JSON), createdBy, committedAt, undoneAt, expiresAt, errorMessage.
- `ImportRow`: batchId, sheetName, rowNumber, original (JSON), transformed (JSON), resolved (JSON), entityDrafts (JSON, for combined rows), status, messages (JSON), resultRecordIds (JSON). Index on `(batchId, status)`.
- `ImportMapping` (saved mappings): name, headerFingerprint, entity, sheetConfig, columnMapping, transforms, createdBy, lastUsedAt, useCount.
- Aliases: `SectorAlias`, `ServiceAlias`, `ClientAlias`, `StatusAlias` (entity, sourceValue → status), `UserAlias` (name → user).
- `importBatchId` (nullable, indexed) on Client, Enquiry, Quotation, Project, PurchaseOrder, PurchaseOrderLine, Invoice, FollowUp.
- `Client.gstin` (unique when present), `Enquiry.externalRef` (unique when present), `pg_trgm` extension + trigram index on `Client.name` and `ClientAlias.alias`.
- `CompanySettings.importAiAssist` (default true), `CompanySettings.importDateFormat` (default `DD/MM/YYYY`).

## Worker jobs

`import.parse`, `import.suggest`, `import.validate`, `import.commit`, `import.undo`, `import.expire-drafts` (nightly). Each updates the batch status and a progress field the UI polls (every 2 seconds, or server-sent events if already used elsewhere).

## Security

- Files stored private in Cloudinary under `imports/`; downloadable only by the uploader and admins; deleted 30 days after commit or on expiry.
- The error report and any export escape cells starting with `=`, `+`, `-` or `@` to prevent formula injection in Excel.
- Rate limit: 10 uploads per user per hour.
- Cell text is treated as data everywhere. When passed to the AI mapping call, samples go in a clearly delimited data section, with an instruction that they contain no instructions.

## Testing

Fixtures in `fixtures/import/`. Each has an expected mapping and expected results:

1. `enquiry-register-messy.xlsx`: logo + title rows, header in row 4, merged client cells, blank rows, a "Grand total" row, mixed date formats, "Pharma"/"Pharmaceuticals".
2. `combined-register-fy24.xlsx`: one row per invoice, repeated PO numbers, statuses "Won/Lost/Negotiation/Paid", amounts in lakhs.
3. `monthly-sheets.xlsx`: 12 sheets with the same layout.
4. `two-row-header.xlsx`: grouped "Quotation" / "PO" / "Invoice" header bands.
5. `invoices-semicolon.csv`: Windows-1252 encoding, semicolon delimiter, `₹` symbols.
6. `legacy.xls` and `tracker.ods`.
7. `ambiguous-dates.xlsx`: every day ≤ 12.
8. `password-protected.xlsx`, `zip-bomb.xlsx`, `formulas.xlsx` (cached values used, formulas not evaluated).

The AI call is mocked in tests with recorded `MappingSuggestion` responses; `heuristic.ts` is tested separately against all fixtures.

## Acceptance criteria

1. All fixture file types parse; the password-protected and oversized files fail with clear messages; formulas are never evaluated.
2. Header row, data range and skipped rows (titles, blanks, repeated headers, totals) are detected correctly for fixtures 1, 3 and 4, and the user can override each.
3. With AI on, one call is made per sheet, containing only headers, ≤ 20 sample rows and distinct values. With AI off or failing, heuristic mapping is used and the user is told.
4. No mapping, value mapping or client match is applied without passing through the Columns and Values steps; required unmapped fields block progress.
5. Ambiguous date columns require an explicit format; unparseable dates and amounts become row errors, not guesses. "₹12.5 L" becomes 1,250,000 rupees; "1.2 Cr" becomes 12,000,000 rupees.
6. The combined register creates correctly linked clients, enquiries, quotations, projects, POs (one per PO number) and invoices; derived PO statuses are correct after commit.
7. Duplicates are detected both within the file and against the database; re-importing the same file in "Add new only" mode creates nothing; "Add and update" updates matched records with audited before/after.
8. The Import button is disabled while errors remain; fixing a cell re-validates only that row; the error report downloads with an issues column and escaped formulas.
9. The commit is all-or-nothing (a forced failure on the last row saves nothing); every record has `importBatchId`; audit rows have source `import` and the batch id.
10. Undo within 7 days reverses creates and updates; records edited after the import block undo and are listed.
11. Saved mappings are applied automatically when the header fingerprint matches, skipping the AI call; confirmed value matches are saved as aliases and reused.
12. RBAC: sales users can't import records for other owners or create masters; PMs are limited to assigned projects; admins see all batches.
13. A 20,000-row combined register validates and commits within 5 minutes on the dev machine, with progress shown throughout.
14. After importing `combined-register-fy24.xlsx`, M12b reports R1–R6 and the M12 dashboard show the fixture's expected figures without restarting or waiting for the cache to expire; undo restores the previous figures.
15. With "Move to a date" chosen, no imported open item appears in My today before that date; no reminder emails or notifications are sent as a result of the commit.
16. The importer creates PO lines and INR amounts through the existing M12b core functions (no duplicate conversion or allocation code).
17. `pnpm typecheck && pnpm lint && pnpm test` passes (including the existing M11, M12 and M12b test suites, unchanged); all wizard screens pass the UI-GUIDE checklist.

## Out of scope

Importing documents (PDF POs/invoices in bulk: use M7 one at a time), scheduled or automatic imports from email/drive, and importing users or settings. The MCP/REST adapter for this engine is M13, if built later.
