'use client';

import type { DocumentKindValue, ExtractionStatusValue } from '@sales-tracker/core/schemas';
import { FileText, Loader2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Button } from '@/components/ui/button';
import type { ActionResult } from '@/lib/action-core';
import { applyResult } from '@/lib/apply-result';
import {
  ACCEPTED_TYPES,
  EXTRACTION_STATUS_TEXT,
  fieldLabel,
  formatBytes,
} from '@/lib/document-labels';
import { formatDateTime } from '@/lib/format';
import { deleteDocumentAction, retryExtractionAction } from '../../documents/actions';

/** What the card needs about the current document (serialisable from the server page). */
export interface DocumentSummary {
  id: string;
  originalFilename: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
  extractionStatus: ExtractionStatusValue;
  extractionError: string | null;
  reviewStatus: 'PENDING' | 'CONFIRMED';
  reviewedBy: string | null;
  reviewedAt: string | null;
  appliedFields: string[];
}

const POLL_MS = 3000;

/** Sends the file to the upload route; the reply has the server-action result shape. */
async function upload(kind: DocumentKindValue, entityId: string, file: File) {
  const body = new FormData();
  body.set('kind', kind);
  body.set('entityId', entityId);
  body.set('file', file);
  try {
    const response = await fetch('/api/documents', { method: 'POST', body });
    return (await response.json()) as ActionResult<{ id: string }>;
  } catch {
    return {
      ok: false as const,
      error: 'The upload did not finish. Check your connection and try again.',
    };
  }
}

/**
 * The record's document (M7): upload, view, replace, delete, and where extraction is.
 * Polls while the document is being read, so "Ready to review" appears on its own.
 */
export function DocumentCard({
  kind,
  entityId,
  document,
  canUpdate,
  maxMb,
}: {
  kind: DocumentKindValue;
  entityId: string;
  document: DocumentSummary | null;
  canUpdate: boolean;
  maxMb: number;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [retrying, startRetry] = useTransition();
  const reading =
    document?.extractionStatus === 'QUEUED' || document?.extractionStatus === 'RUNNING';

  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [reading, router]);

  async function send(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    const result = await upload(kind, entityId, file);
    setUploading(false);
    if (input.current) input.current.value = '';
    if (applyResult(result, undefined, 'Document uploaded')) router.refresh();
  }

  const picker = (
    <input
      ref={input}
      type="file"
      accept={ACCEPTED_TYPES}
      className="sr-only"
      aria-label="Choose a document"
      onChange={(event) => send(event.target.files?.[0])}
    />
  );

  return (
    <section
      aria-labelledby="document-heading"
      className="bg-card flex max-w-3xl flex-col gap-3 rounded-[var(--radius)] border p-4"
    >
      <h2 id="document-heading" className="text-base font-semibold">
        Document
      </h2>

      {!document && !canUpdate && (
        <p className="text-muted-foreground text-sm">No document has been attached yet.</p>
      )}

      {!document && canUpdate && (
        <label
          className="hover:bg-accent flex cursor-pointer flex-col items-center gap-2 rounded-[var(--radius)] border border-dashed p-6 text-center data-[dragging=true]:bg-accent focus-within:ring-ring focus-within:ring-2 focus-within:ring-offset-2"
          data-dragging={dragging}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void send(event.dataTransfer.files[0]);
          }}
        >
          {uploading ? (
            <Loader2 className="text-muted-foreground size-5 animate-spin" aria-hidden />
          ) : (
            <Upload className="text-muted-foreground size-5" aria-hidden />
          )}
          <span className="text-sm font-medium">
            {uploading ? 'Uploading…' : 'Upload quotation document'}
          </span>
          <span className="text-muted-foreground text-[13px]">
            Drop a file here or choose one. PDF, PNG, JPEG or WebP, up to {maxMb} MB.
          </span>
          {picker}
        </label>
      )}

      {document && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <FileText className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" title={document.originalFilename}>
                  {document.originalFilename}
                </p>
                <p className="text-muted-foreground text-[13px]">
                  {formatBytes(document.sizeBytes)} · uploaded by {document.uploadedBy} on{' '}
                  {formatDateTime(document.createdAt)}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <a href={`/api/documents/${document.id}/file`} target="_blank" rel="noreferrer">
                  View
                </a>
              </Button>
              {canUpdate && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={uploading}
                    onClick={() => input.current?.click()}
                  >
                    {uploading && <Loader2 className="size-4 animate-spin" aria-hidden />}
                    Replace
                  </Button>
                  {picker}
                  <ConfirmButton
                    label="Delete"
                    variant="destructive"
                    title={`Delete ${document.originalFilename}?`}
                    description="The quotation will have no document. You can upload another one."
                    success="Document deleted"
                    run={() => deleteDocumentAction({ id: document.id })}
                  />
                </>
              )}
            </div>
          </div>

          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
          >
            {document.reviewStatus === 'CONFIRMED' ? (
              <p className="text-sm">
                Confirmed by {document.reviewedBy} on {formatDateTime(document.reviewedAt!)}.{' '}
                <span className="text-muted-foreground">
                  {document.appliedFields.length > 0
                    ? `Applied ${document.appliedFields.map(fieldLabel).join(', ')}.`
                    : 'No values were changed.'}
                </span>
              </p>
            ) : (
              <div className="flex flex-col gap-0.5">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {reading && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  {EXTRACTION_STATUS_TEXT[document.extractionStatus]}
                </p>
                {document.extractionStatus === 'FAILED' && document.extractionError && (
                  <p className="text-muted-foreground text-[13px]">{document.extractionError}</p>
                )}
                {document.extractionStatus === 'SKIPPED' && (
                  <p className="text-muted-foreground text-[13px]">
                    Enter the values on the quotation yourself, or ask an admin to turn on reading
                    documents with AI.
                  </p>
                )}
              </div>
            )}
            {document.reviewStatus === 'PENDING' && (
              <div className="flex gap-2">
                {canUpdate &&
                  (document.extractionStatus === 'FAILED' ||
                    document.extractionStatus === 'SKIPPED') && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={retrying}
                      onClick={() =>
                        startRetry(async () => {
                          const result = await retryExtractionAction({ id: document.id });
                          if (applyResult(result, undefined, 'Reading the document again')) {
                            router.refresh();
                          }
                        })
                      }
                    >
                      Try again
                    </Button>
                  )}
                {document.extractionStatus === 'SUCCEEDED' && (
                  <Button asChild size="sm">
                    <Link href={`/documents/${document.id}/review`}>Review</Link>
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
