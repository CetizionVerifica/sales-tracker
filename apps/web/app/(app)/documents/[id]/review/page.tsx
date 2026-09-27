import { getDocument, getSettings, NotFoundError } from '@sales-tracker/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireUser } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';
import { AutoRefresh } from './AutoRefresh';
import { ReviewForm, type ReviewFormRow } from './ReviewForm';

export const metadata = { title: 'Review document · Sales Tracker' };

const KIND_PATHS = {
  QUOTATION: 'quotations',
  PURCHASE_ORDER: 'purchase-orders',
  INVOICE: 'invoices',
};
const KIND_LISTS = {
  QUOTATION: 'Quotations',
  PURCHASE_ORDER: 'Purchase orders',
  INVOICE: 'Invoices',
};

/**
 * Review and confirm extracted values (M7, UI guide 4.5): the document on the left, the
 * values on the right. Nothing reaches the record until the user confirms.
 */
export default async function ReviewDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const document = await getDocument(ctx, (await params).id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const settings = await getSettings(ctx);
  const recordHref = `/${KIND_PATHS[document.kind]}/${document.entityId}`;
  const fileUrl = `/api/documents/${document.id}/file`;
  const reading = document.extractionStatus === 'QUEUED' || document.extractionStatus === 'RUNNING';
  const reviewed = document.reviewStatus === 'CONFIRMED';
  const editable =
    document.canUpdate && document.isCurrent && !reviewed && document.deletedAt === null;

  const rows: ReviewFormRow[] = (document.review?.fields ?? []).map((row) => ({
    name: row.name,
    label: row.label,
    input: row.input,
    applies: [...row.applies],
    extracted: row.extracted,
    current: row.current,
    lockedReason: row.lockedReason,
    suggested: row.suggested,
  }));

  return (
    <>
      <AutoRefresh active={reading} />
      <PageHeader
        breadcrumbs={[
          { label: KIND_LISTS[document.kind], href: `/${KIND_PATHS[document.kind]}` },
          { label: document.entityLabel, href: recordHref },
          { label: 'Review document' },
        ]}
        title={`Review ${document.originalFilename}`}
        description={`Check the values read from the document. Nothing changes on ${document.entityLabel} until you confirm.`}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="bg-card min-h-[480px] overflow-hidden rounded-[var(--radius)] border">
          {document.mimeType === 'application/pdf' ? (
            <iframe title={document.originalFilename} src={fileUrl} className="h-[75vh] w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a private, per-request file
            <img src={fileUrl} alt={document.originalFilename} className="w-full object-contain" />
          )}
        </div>

        <div className="bg-card flex flex-col gap-4 rounded-[var(--radius)] border p-4">
          {reviewed && (
            <p role="status" className="text-sm">
              Confirmed by {document.reviewedBy?.name} on {formatDateTime(document.reviewedAt!)}.
            </p>
          )}
          {!document.isCurrent && !reviewed && (
            <p role="status" className="text-sm">
              This is no longer the current document on {document.entityLabel}, so its values cannot
              be applied.
            </p>
          )}
          {reading && (
            <div role="status" className="flex flex-col gap-3">
              <p className="text-sm font-medium">Reading document…</p>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          )}
          {document.extractionStatus === 'FAILED' && !reviewed && (
            <p role="alert" className="text-sm">
              {document.extractionError ?? 'The document could not be read automatically.'}{' '}
              <Link className="underline" href={recordHref}>
                Back to {document.entityLabel}
              </Link>
            </p>
          )}
          {document.extractionStatus === 'SKIPPED' && !reviewed && (
            <p role="status" className="text-sm">
              Reading documents with AI was turned off when this was uploaded, so there are no
              values to review. Enter them on the quotation yourself, or use Try again on{' '}
              <Link className="underline" href={recordHref}>
                {document.entityLabel}
              </Link>{' '}
              once an admin turns it on.
            </p>
          )}
          {document.review && (
            <ReviewForm
              kind={document.kind}
              documentId={document.id}
              recordLabel={document.entityLabel}
              recordHref={recordHref}
              rows={rows}
              info={document.review.info}
              clientMismatch={document.review.clientMismatch}
              currencies={settings.enabledCurrencies}
              editable={editable}
              appliedFields={reviewed ? document.appliedFields : null}
            />
          )}
        </div>
      </div>
    </>
  );
}
