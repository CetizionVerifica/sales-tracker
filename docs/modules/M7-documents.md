# M7 — Documents and extraction

Depends on: M0, M1, M2, M3, M4, M5, M6.

## Goal

Quotations, purchase orders and invoices arrive as PDFs or scans. Users attach the file to its record. A background job asks Claude to read the key fields, and the user checks them on a review screen before anything is written to the record.

- Upload a PDF or image to Cloudinary and attach it to a pipeline record, with RBAC and audit logging through `packages/core`.
- A BullMQ `documents` queue and a worker job that sends the file to the Claude API and gets back structured JSON, validated by a Zod schema per document kind.
- A review-and-confirm screen: extracted values next to the record's current values, editable, applied only when the user confirms.
- A small **document-kind registry** (the same pattern as M5's follow-up targets) so M9 (PO: amount, payment terms) and M10 (invoice: number, date, client) add a kind without touching the pipeline.
- M7 ships one kind, **`QUOTATION`**, which fills M6's "document" field and proves the whole flow end to end.
- Document events on the client timeline (the `DOCUMENT` kind M5 reserved).

PLAN.md "done when": extracted values never save without user confirmation.

## In scope

### Database (`packages/db`)

- **`DocumentKind`** enum: `QUOTATION`, `PURCHASE_ORDER`, `INVOICE`. All three exist now so M9/M10 need no enum migration; the service accepts only kinds whose module has shipped (as M5 Decision 3).
- **`ExtractionStatus`** enum: `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SKIPPED` (extraction turned off, or the file type or size can't be sent).
- **`DocumentReviewStatus`** enum: `PENDING`, `CONFIRMED` (CLAUDE.md rule 9).
- **`Document`**:
  - `id`, `kind DocumentKind`, `entityId String` (the quotation/PO/invoice id; polymorphic, no FK, checked by the service as `FollowUp.entityId` is), `clientId` (FK `Client`, copied from the record), `uploadedById` (FK `User`).
  - `storageKey String @unique`: the Cloudinary `public_id`. `resourceType String` (`image` or `raw`; PDFs upload as `image` so Cloudinary can render page previews, see Risks).
  - `originalFilename String` (≤ 255 chars), `mimeType String`, `sizeBytes Int`, `sha256 String` (hex).
  - `extractionStatus ExtractionStatus @default(QUEUED)`, `extractionAttempts Int @default(0)`, `extractionError String?` (user-safe message, ≤ 500 chars), `extractionModel String?`, `extractedAt DateTime?`.
  - `extraction Json?`: the validated extraction output (shape per kind, below). Never read by anything except the review screen and M13's read tools.
  - `reviewStatus DocumentReviewStatus @default(PENDING)`, `reviewedById String?` (FK `User`), `reviewedAt DateTime?`.
  - `appliedFields String[]`: the fields the reviewer chose to write to the record on confirm (empty when they confirmed without applying anything).
  - `createdAt`, `updatedAt`, `deletedAt DateTime?` (soft-deletable).
  - Indexes: `(kind, entityId)`, `(clientId, createdAt)`, `(uploadedById, reviewStatus)` (M11 "documents to review"), `(extractionStatus, updatedAt)` (the stuck-job sweeper).
- **`Quotation.documentId String? @unique`** (FK `Document`): the quotation's current document. M9 and M10 add the same column to `PurchaseOrder` and `Invoice`.
- **`CompanySettings.documentExtractionEnabled Boolean @default(true)`**: lets an admin stop files being sent to the Claude API (Decision 6).
- `CHECK` constraints in the migration SQL:
  - `"reviewStatus" <> 'CONFIRMED' OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)`.
  - `"sizeBytes" > 0`.
  - `"extractionStatus" <> 'SUCCEEDED' OR "extraction" IS NOT NULL`.
- Audited automatically; the M2 coverage test must pass. The `extraction` JSON is included in audit snapshots (it is what the reviewer saw; capped at 64 KB by the schema).
- Migration: `m7_documents`.

### Env (`packages/core/env.ts`, `.env.example`)

- `ANTHROPIC_API_KEY` (required, non-empty). Tests set a dummy value; the API is always mocked there.
- `ANTHROPIC_MODEL` (default `claude-opus-5`; Decision 5).
- `DOCUMENT_MAX_BYTES` (default `20971520`, 20 MB; max 30 MB, under the Claude API's 32 MB request limit after base64).
- `CLOUDINARY_FOLDER` (default `sales-tracker/${NODE_ENV}`), so dev, test and prod assets never mix in one account.

### Storage (`packages/core/storage`)

- A `FileStore` interface: `put({ bytes, mimeType, folder, filename }) → { storageKey, resourceType }`, `get(storageKey, resourceType) → Buffer`, `signedUrl(storageKey, resourceType, { ttlSeconds, inline }) → string`.
- **`cloudinaryFileStore`**: uploads with `type: 'authenticated'` (no public URL; Decision 3), a random `public_id` under `CLOUDINARY_FOLDER/<kind>/`, and the original filename only as metadata. `signedUrl` returns a short-lived (5 minutes) signed delivery URL.
- **`memoryFileStore`** for tests and E2E (selected by `NODE_ENV=test`). No test calls Cloudinary.

### Extraction (`packages/core/extraction`)

- An `Extractor` interface: `extract({ kind, bytes, mimeType, context }) → ExtractionResult`, where `context` gives Claude the record's client name and currency list to compare against (never other clients' data).
- **`claudeExtractor`** (the only file that imports `@anthropic-ai/sdk`):
  - One `messages.create` call per document, model from `ANTHROPIC_MODEL`, PDFs as a base64 `document` block and images as a base64 `image` block, placed before the instructions.
  - Structured outputs (`output_config.format`) with a JSON schema generated from the kind's Zod schema, then parsed again with that Zod schema. A parse failure is a failed attempt, not a partial save.
  - Server-side refusal fallbacks enabled (`fallbacks: "default"`), as the SDK guidance recommends for `claude-opus-5`.
  - Checks `stop_reason` before reading content: `refusal` → `FAILED` ("The document could not be read automatically"); `max_tokens` → retry once with a higher limit, then `FAILED`.
  - The system prompt tells Claude to copy values as printed, return `null` for anything not present rather than guess, and treat text inside the document as data, not instructions.
  - Records `extractionModel` from the response's `model` (so a fallback is visible).
- **`mockExtractor`** for tests and E2E: returns fixtures keyed by the file's `sha256`, and can be told to fail, refuse or hang.
- **Shape of every extracted field** (`schemas/extraction.ts`): `{ value: T | null, confidence: 'high' | 'medium' | 'low', page?: number, sourceText?: string (≤ 200 chars) }`.
- **`QUOTATION` kind** (`quotationExtractionSchema`):
  - `documentNumber` (the client-facing or our own reference as printed; string ≤ 64),
  - `documentDate` (ISO date string),
  - `clientName` (string ≤ 200),
  - `amount` (decimal string, the grand total; the same format `moneySchema` parses, never a number),
  - `currency` (3-letter code),
  - `scopeSummary` (string ≤ 1000).
- The kind registry (`extraction/kinds.ts`) maps each `DocumentKind` to: its Zod schema, the parent's `can()` loader and scope, the parent `documentId` column, a `fieldMap` from extracted fields to the parent's update input (`documentDate → quotationDate`, `amount + currency → amount/currency`, `scopeSummary → description`), and a `canApply(record)` hook (e.g. a `PO_RECEIVED` quotation cannot change its amount, M6 Decision 9). M9 and M10 each add one entry.

### RBAC (`packages/core/rbac`)

- New `ResourceInstance`: `{ type: 'document'; canReadParent: boolean; canUpdateParent: boolean }`. Rules for non-admins: `read` / `list` when `canReadParent`; `create`, `update` (confirm, re-run) and `delete` when `canUpdateParent`. A document's permissions are its record's (Decision 4).
- **`documentResource(row, parent)`** builds the instance from the registry's parent loader.
- **`scopeDocuments(user)`**: `ADMIN` `{}`; others an `OR` per kind of `{ kind, entityId: { in: <ids from that kind's scope> } }`, as `scopeFollowUps`.
- Project managers: quotation documents follow `scopeQuotations`, so they see none until M8 (pinned by a test, as M6 did).

### Schemas (`packages/core/schemas/document.ts`)

- `uploadDocumentSchema`: `{ kind, entityId }` plus the file checked in the service: `mimeType` in `application/pdf`, `image/png`, `image/jpeg`, `image/webp`; size 1 byte – `DOCUMENT_MAX_BYTES`; the file's **magic bytes** must match the declared type (`%PDF-`, PNG signature, `FF D8 FF`, `RIFF….WEBP`). No new dependency for this.
- `confirmExtractionSchema`: `{ documentId, apply: { [field]: string | null } }`, where `apply` holds only the fields the reviewer ticked, with the values as edited. The service converts them through the kind's `fieldMap` and validates the result with the **parent's own update schema** (e.g. `updateQuotationSchema`), so the same rules apply as when typing into the form.
- `listDocumentsSchema`: `listParamsSchema` plus `kind[]`, `entityId`, `clientId`, `uploadedById`, `extractionStatus[]`, `reviewStatus[]`, `recordStatus`.

### Services (`packages/core/services/document.service.ts`)

Each function takes `ctx`, validates, calls `assertCan`, and writes inside `withTx`. Conditional `updateMany` guards (the M4/M5 race fix) protect confirm, re-run and delete.

- `uploadDocument(ctx, { kind, entityId, file })`:
  - Loads the parent through the registry; missing, soft-deleted or unreadable → `NotFoundError`; readable but not updatable → `ForbiddenError`.
  - Validates type, size and magic bytes; computes `sha256`.
  - Puts the file in the `FileStore` **before** the transaction (an orphaned asset is harmless; an orphaned row is not). If the transaction then fails, the service deletes the asset best-effort.
  - In one transaction: creates the `Document` (`extractionStatus = QUEUED`, or `SKIPPED` when extraction is disabled), sets the parent's `documentId` to it, and soft-deletes the previous current document if there was one (Decision 2).
  - After commit, enqueues `extract` with `jobId = documentId` (so a double enqueue is a no-op).
- `runExtraction(systemCtx, documentId)` (called by the worker only, `source: 'system'`):
  - Claims the job with `updateMany where extractionStatus in (QUEUED, FAILED) → RUNNING`, incrementing `extractionAttempts`. A deleted document or one already `CONFIRMED` is skipped.
  - Reads the file from the `FileStore`, calls the `Extractor`, and stores `extraction`, `extractionModel`, `extractedAt` and `SUCCEEDED`; or `FAILED` with a user-safe `extractionError`. **It never writes to the parent record.**
- `retryExtraction(ctx, documentId)`: `update` permission; allowed when `FAILED` or `SUCCEEDED` and still `PENDING` review; resets to `QUEUED` and enqueues.
- `getDocument(ctx, id)`: returns metadata, extraction, the parent's current values for each mapped field, `canApply` per field, and a fresh `signedUrl` for preview. Not visible → `NotFoundError`.
- `confirmExtraction(ctx, input)`:
  - `update` permission; the document must be the parent's **current** document, `PENDING`, and `SUCCEEDED` (or `FAILED`/`SKIPPED` with an empty `apply`, so a user can clear the item from their review list).
  - In one transaction: applies `apply` to the parent through the parent's **own service function** (e.g. `updateQuotation`), which runs its RBAC, status rules and audit as usual; then sets `reviewStatus = CONFIRMED`, `reviewedById`, `reviewedAt` and `appliedFields`. Both writes share one `requestId`.
  - A field the parent rejects (e.g. an amount on a `PO_RECEIVED` quotation) fails the whole confirm with a field error; nothing is written.
  - This is the only path from `Document.extraction` to a pipeline record (**the "done when"**).
- `softDeleteDocument` / `restoreDocument`: `delete` permission. Deleting the current document clears the parent's `documentId`; restoring makes it current again only if the parent has none. The Cloudinary asset is kept (soft delete only; purge is M14).
- `listDocuments(ctx, input)` and `listDocumentsPendingReview(ctx)` (the reviewer's own uploads with `SUCCEEDED` extraction and `PENDING` review; M11 uses it).
- **Client-name check:** `getDocument` compares the extracted `clientName` with the record's client (case, punctuation and suffixes like "Pvt Ltd" / "Private Limited" normalised). A mismatch shows a warning on the review screen. The client itself is never changed from a document (M6 Decision 6); M10 reuses the check for its invoice mismatch warning.

**Timeline** (`timeline.service.ts`): the `DOCUMENT` kind is sourced from `Document` audit rows, filtered by `scopeDocuments`. Events: uploaded (`CREATE`), reviewed (`UPDATE` where `reviewStatus` becomes `CONFIRMED`, summary lists `appliedFields`), replaced/deleted (`SOFT_DELETE`), restored. The summary shows kind, filename and the record label; never the extracted values.

### Worker (`apps/worker`)

- Registers a `documents` queue processor for `extract` jobs that calls `runExtraction` with a system context. Concurrency 2 (Anthropic rate limits; Decision 7).
- BullMQ retries: 3 attempts, exponential backoff from 30 s, only for retryable errors (429, 5xx, network). A validation failure or refusal is final.
- **Sweeper:** on start and every 10 minutes, re-enqueues documents stuck in `QUEUED` for over 5 minutes (the enqueue after commit failed) or `RUNNING` for over 15 minutes (the worker died mid-job).
- `apps/web` gets a small enqueue helper in core (`enqueueExtraction(documentId)`); the web app never imports the worker.

### Seed

- No documents are seeded: the seed must run without network access and without a Cloudinary account. A dev-only script `pnpm --filter core seed:documents` uploads two sample quotation PDFs from `packages/core/test/fixtures/` to the dev Cloudinary account, for manual testing.

### Web (`apps/web`)

- **Upload route:** `POST /api/documents` (route handler, not a server action, because of the 1 MB server-action body limit; see Risks). Multipart `file`, `kind`, `entityId`; returns the `{ ok, data } | { ok, error }` shape. Streams are capped at `DOCUMENT_MAX_BYTES`.
- **`/quotations/[id]`**: a **Document** card:
  - None: an **Upload quotation document** drop zone (PDF, PNG, JPEG, WebP; up to 20 MB).
  - Present: filename, size, uploaded by/when, **View** (opens the signed URL), **Replace**, **Delete**, and the extraction state: "Reading document…" (polls every 3 s while `QUEUED`/`RUNNING`), "Ready to review" with a **Review** button, "Could not read" with the reason and **Try again**, "Extraction is turned off", or "Reviewed by <name> on <date>" with the applied fields.
- **`/documents/[id]/review`**:
  - Left: the document preview (PDF in an `<iframe>` from the signed URL; images inline).
  - Right: one row per mapped field: label, extracted value (with a low-confidence badge and the source text on hover), the record's current value, an editable input pre-filled with the extracted value, and an **Apply** checkbox. The box is ticked by default only when the value differs from the current one and confidence is not `low`; fields `canApply` rejects are disabled with the reason.
  - The client-name mismatch warning sits above the table.
  - **Confirm** (applies the ticked fields and marks it reviewed) and **Confirm without changes**. Both show a summary dialog listing exactly what will change. Nothing is written until the user confirms.
  - React Hook Form + `zodResolver` with the core schemas; server action via M1's `action()`.
- **`/clients/[id]`** and record timelines render `DOCUMENT` events (M5 component; add the icon and summary).
- **Admin settings**: a **Read documents with AI** switch for `documentExtractionEnabled`, with a line explaining that files are sent to the Anthropic API.

## Out of scope

- Purchase order and invoice documents and their extraction kinds: M9 and M10 (they add a registry entry, the `documentId` column and their review fields).
- Using a document to **create** a record (e.g. upload a PO first, then create the PO from it): M9 decides.
- Several attachments per record (supporting files, email threads): not planned; one current document per record (Decision 2).
- Hard deletion and purging of Cloudinary assets, virus scanning, and upload rate limits: M14.
- Documents on enquiries: not planned (M4 out of scope).
- MCP tools for documents and bulk import of files: M13.
- OCR fallback or a second model for failed documents.

## Acceptance criteria

**Service and data** (integration tests against the test database, with `memoryFileStore` and `mockExtractor`):

1. **AC1 (upload):** a Sales user uploads a PDF to their own `SENT` quotation. A `Document` row exists with `kind = QUOTATION`, the quotation's `clientId`, `QUEUED`, `PENDING`, correct `sizeBytes`/`sha256`; the quotation's `documentId` points to it; one extraction job is enqueued with `jobId = documentId`; the audit log has `Document CREATE` and `Quotation UPDATE` under one `requestId` with `source: 'web'`.
2. **AC2 (validation):** rejected with field errors: an unsupported MIME type (`.docx`, `.heic`), an empty file, a file over `DOCUMENT_MAX_BYTES`, a `.pdf` whose bytes are a PNG (magic-byte mismatch), an unknown or soft-deleted quotation, and `kind = PURCHASE_ORDER` or `INVOICE` (module not shipped).
3. **AC3 (extraction):** running the job with a fixture sets `SUCCEEDED`, the validated `extraction`, `extractionModel` and `extractedAt`, and writes **no** audit row for `Quotation`. A mocked extractor returning JSON that fails the Zod schema, a `refusal`, and a non-retryable 400 each end `FAILED` with a user-safe message and no `extraction`. A 429 is retried by BullMQ and succeeds on the second attempt.
4. **AC4 (the "done when"):** after extraction succeeds, the quotation's amount, date and description are unchanged, and stay unchanged across `getDocument`, `retryExtraction`, a worker restart and a second job run. Only `confirmExtraction` changes them. A test asserts no code path other than `confirmExtraction` writes to a parent from `Document.extraction` (grep-style test over `packages/core` for the registry's `fieldMap` usage).
5. **AC5 (confirm):** confirming `amount = "1,25,000.50"`, `currency = INR` and `quotationDate` on an active quotation updates it through `updateQuotation` and marks the document `CONFIRMED` with `appliedFields = ['amount', 'currency', 'quotationDate']`, both under one `requestId`. An edited value (the user corrects the amount) is what gets saved. **Confirm without changes** leaves the quotation untouched and records `appliedFields = []`.
6. **AC6 (confirm rules):** confirming is rejected when the document is not the quotation's current one, already `CONFIRMED`, soft-deleted, or still `QUEUED`/`RUNNING`; when an applied value fails the quotation's rules (a future date, a disabled currency, too many decimals); and when applying an amount to a `PO_RECEIVED` or `LOST` quotation. In each case neither the quotation nor the document changes.
7. **AC7 (RBAC):** a Sales user cannot upload to, view, re-run, confirm or delete documents on another rep's quotation (`NotFoundError` for view; not found or forbidden for writes, matching the parent's behaviour). Project managers see no quotation documents (pinned until M8). Admins can do everything. Each service function has happy-path, permission-denial and audit-row tests.
8. **AC8 (replace and delete):** uploading a second document soft-deletes the first (`SOFT_DELETE` audit row) and makes the new one current; the first can no longer be confirmed. Deleting the current document clears `documentId`; restoring it sets it again when the quotation has none.
9. **AC9 (disabled extraction):** with `documentExtractionEnabled = false`, an upload is `SKIPPED`, no job is enqueued, and the extractor is never called. Turning it back on and pressing **Try again** queues it.
10. **AC10 (worker robustness):** a document left `QUEUED` with no job, or `RUNNING` past the timeout, is picked up by the sweeper. Two workers racing for one job: exactly one runs the extractor. A job for a deleted or confirmed document does nothing.
11. **AC11 (client check):** "Acme Engineering Pvt. Ltd." matches a client named "ACME Engineering Private Limited"; "Globex Ltd" does not and returns a mismatch warning.
12. **AC12 (timeline):** the client timeline shows the upload, the review (with applied fields) and a replacement in date order among quotation events, only to users who can read the quotation, and never shows extracted values.
13. **AC13 (claudeExtractor, unit):** with the Anthropic client mocked, a PDF is sent as a base64 `document` block and an image as an `image` block, the model comes from `ANTHROPIC_MODEL`, the request uses structured output for the kind's schema, and `stop_reason` values `refusal` and `max_tokens` are handled as specified. No test reaches the network (the test setup fails any outbound HTTP).

**End-to-end (Playwright, `memoryFileStore` + `mockExtractor`):**

14. **AC14:** a Sales user opens a quotation, uploads a sample PDF, sees "Reading document…" change to "Ready to review", opens the review screen, sees the extracted amount next to the current one and a client mismatch warning for the mismatching fixture, corrects the amount, confirms, and sees the new amount on the quotation and the review on its timeline. Reloading the review URL shows it as reviewed, read-only.
15. **AC15:** a second Sales user gets a not-found page at the document's review URL.

**Quality:**

16. **AC16:** `pnpm typecheck && pnpm lint && pnpm test` pass, `m7_documents` applies to an empty database after M6, and `Document` passes the M2 audit coverage test.

## Decisions

1. **Extraction is a suggestion stored on the document, never on the record** (CLAUDE.md rule 9). The worker writes only to `Document`; the record changes only through `confirmExtraction`, which calls the record's normal update service, so RBAC, status rules and audit behave exactly as if the user had typed the values.
2. **One current document per record, replaceable.** CLAUDE.md models "document" as a single field on quotation, PO and invoice. A replaced document is soft-deleted, not removed, so the audit log and timeline keep the history. Extra attachments are not planned.
3. **Files are private.** Cloudinary `authenticated` delivery with 5-minute signed URLs generated per view after a `read` check; no public URLs are stored or rendered. The original filename is kept as metadata only, not in the `public_id`.
4. **A document's permissions are its record's.** Anyone who can update the quotation can upload, re-run and confirm its document; anyone who can read it can view it. No separate document roles.
5. **Model:** `claude-opus-5` by default (the current recommended model for accuracy on dense or scanned financial documents), configurable with `ANTHROPIC_MODEL` so the company can trade accuracy for cost (e.g. `claude-sonnet-5`) without a code change.
6. **Admins can turn extraction off** (`documentExtractionEnabled`), because client documents are sent to a third-party API. Uploads still work; the review screen is skipped.
7. **Extraction runs in the worker, not the request.** A large PDF can take tens of seconds; the queue gives retries, rate-limit control (concurrency 2) and a sweeper for jobs lost between commit and enqueue.
8. **Amounts come back as decimal strings**, parsed by M6's `moneySchema` on confirm. No floating-point number is produced or stored anywhere in the path (CLAUDE.md rule 5).

## Dependencies

- **`@anthropic-ai/sdk`** (in `packages/core`): the official client for the Claude API (PDF/image input, structured outputs, typed errors, retries).
- **`cloudinary`** (in `packages/core`): the official Node SDK for authenticated uploads and signed URLs.
- `bullmq` is already in the worker; `packages/core` gains it for the enqueue helper (it already depends on `ioredis`).
- No PDF parsing or file-type library: magic bytes are checked by hand, and page counts are left to the Claude API (a too-long PDF fails with a clear message).

## Risks

- **Prompt injection from documents.** A PDF can contain text aimed at the model. Mitigations: the output is schema-constrained and length-capped, only used as a suggestion, shown with its source text, and applied only after a human confirms through the normal validation.
- **Upload size vs Next.js limits.** Server actions cap bodies at 1 MB by default, hence the route handler. Check the reverse proxy's body limit too (M14).
- **Cloudinary PDF handling.** PDFs uploaded as `image` count toward transformation quotas and some accounts block PDF delivery by default ("Allow delivery of PDF and ZIP files" in security settings). Verify on the dev account first; fall back to `raw` (no preview thumbnails, iframe still works through the signed URL).
- **Commit-then-enqueue gap.** If Redis is down right after the commit, the document sits `QUEUED`. The sweeper covers it; AC10 tests it.
- **Cost and latency.** One Opus call per upload. Log `usage` tokens per job so M12/M14 can report spend; revisit the model default if volumes grow.
- **Audit snapshot size.** `extraction` JSON goes into `before`/`after`. The 64 KB cap keeps rows bounded; if it proves noisy, exclude `extraction` from snapshots in `model-meta.ts` rather than skipping the audit.

## Open questions

- [x] Is 20 MB the right upload limit? Built with 20 MB (`DOCUMENT_MAX_BYTES`), approved with the plan. Scanned multi-page POs can be larger; 30 MB is the most the Claude API path allows.
- [x] Should only the uploader see a document in their "to review" list (M11), or everyone who can update the record? Built as recommended: the uploader, plus the record owner if different.
- [ ] Is sending client documents to the Anthropic API acceptable under the company's client contracts? Decision 6 gives admins an off switch; confirm the default (on) before M7 ships.
- [x] Should re-running extraction on an already-`SUCCEEDED` document be allowed (e.g. after changing the model), or only after a failure? Built as allowed (service); the card offers **Try again** only after a failure or when extraction was off.

## Implementation notes (decided during the build)

- **Driver switches instead of `NODE_ENV`.** `FILE_STORE` (`cloudinary` | `local` | `memory`) and `EXTRACTOR` (`claude` | `mock`) pick the implementations, because the Playwright server runs as `development` (`next dev`) or `production` (`next start` in CI), never `test`. `env.ts` rejects `local`, `memory` and `mock` in production **unless `BETTER_AUTH_URL` is loopback** (the same exemption the https rule already had, so the CI production build can run E2E), and `memory` outside tests. Vitest sets `memory` + `mock` in `vitest.setup.ts`; tests swap in their own instances with `setDocumentDeps()`.
- **`ANTHROPIC_API_KEY` is required in production only.** Elsewhere a missing key fails each extraction with "Document reading is not configured", so `pnpm dev` works without one. `QUEUE_PREFIX` (default `bull`) keeps test and E2E jobs out of the dev queue in the same Redis.
- **Two-layer extraction schema.** The wire schema sent as structured output has plain types only (no lengths or formats), so one odd value never fails the whole document; `normaliseExtraction` then trims, caps, and keeps dates/amounts/currencies only in the formats the record's schema takes (anything else becomes null with low confidence). Amounts stay decimal strings end to end.
- **Claude call.** One streamed `client.beta.messages.stream` per document (streaming because the `max_tokens` retry uses 32 000), `output_config.format` from `betaZodOutputFormat`, `fallbacks: 'default'` with the `server-side-fallback-2026-07-01` beta, `maxRetries: 0` (BullMQ owns retries). The reply text is parsed with the wire schema ourselves rather than trusting `parsed_output`.
- **Review fields.** The registry maps extracted fields to record fields per row: `documentDate → quotationDate`, `amount + currency → amount, currency` (one row; both or neither), `scopeSummary → description`. `documentNumber` and `clientName` are shown for information only. A row is pre-ticked when it differs from the record, is not low confidence and is not locked (a closed quotation locks date and amount). `appliedFields` stores the record's field names.
- **Replacement and races.** `setDocument` is a conditional update on the record's current `documentId`, so two uploads racing cannot leave an orphaned "current" document. A replaced document is soft-deleted in the same transaction, so confirming it afterwards is "not found"; a restored non-current document is live but rejected with a `DomainError`.
- **Retry clears the old result.** "Try again" moves `SUCCEEDED | FAILED | SKIPPED → QUEUED` and clears `extraction`, so the review screen never shows a stale result as current. A job that finds extraction turned off leaves the document `QUEUED` (not `SKIPPED`), so "Try again" picks it up after an admin turns it back on.
- **Retryable errors.** `runExtraction(ctx, id, { attempt, maxAttempts })` puts a document back to `QUEUED` and rethrows on a retryable error before the last attempt (BullMQ retries with backoff); on the last attempt it is `FAILED` with "The reading service is busy…". A result from a run the sweeper already re-queued is discarded (writes are guarded on `RUNNING`).
- **File access.** `GET /api/documents/[id]/file` checks read access, then redirects to a 5-minute signed Cloudinary link, or streams the bytes for the local/memory stores (`nosniff`, `private, no-store`). The review page and the card only ever link to this route.
- **Upload route.** `POST /api/documents` reads the body with a byte cap (`DOCUMENT_MAX_BYTES` + 64 KB) instead of trusting `Content-Length`, checks `Origin` against `BETTER_AUTH_URL` or the request host (route handlers have no built-in CSRF check, unlike server actions), and returns the action result shape. `/api/documents` is excluded from `proxy.ts`, which buffers bodies only up to 10 MB; the routes check the session themselves.
- **Timeline.** Document audit rows (`CREATE`, `UPDATE` with `reviewStatus`, `SOFT_DELETE`, `RESTORE`) come from the same audit query as the record events and show on the record they belong to. A replacement's two rows share a transaction timestamp, so their order within that instant is by id.
- **"To review" list.** `listDocumentsPendingReview` returns extracted, unreviewed, current documents the user uploaded **or** whose quotation they own (the open question's recommendation).
- **UI guide.** `docs/UI-GUIDE.md` arrived during the build. The M7 screens follow it where the app already has the pieces (template 4.5 for review, sentence case, tokens only, loading/empty/error states); `--warning` / `--warning-soft` were added to `globals.css` for low-confidence rows. The shared shell and components the guide lists (`AppShell`, `PageHeader`, `PipelineStrip`, `Money`, the full token set) do not exist yet and are left for a separate retrofit.
- **Seed.** `pnpm --filter @sales-tracker/core seed:documents` (development only) attaches `test/fixtures/documents/globex-quotation.pdf` to up to two open quotations through the real upload path.
- **E2E.** Playwright starts the worker as a second web server (waits for `worker ready` on stdout) with the same `FILE_STORE=local`, `EXTRACTOR=mock` and `MOCK_EXTRACTOR_FIXTURES` env as the app. The quotation E2E helpers moved to `e2e/helpers.ts`.
