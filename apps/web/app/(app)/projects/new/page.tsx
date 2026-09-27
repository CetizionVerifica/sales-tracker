import { DomainError, getProjectDraft, NotFoundError } from '@sales-tracker/core';
import { formatMoney } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireUser } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadQuotationOr404 } from '../../quotations/load';

export const metadata = { title: 'New project · Sales Tracker' };

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Placeholder until M8 builds the project form: shows the draft a PO_RECEIVED quotation
 * hands over (getProjectDraft), so the M6 hand-off can be tested end to end.
 */
export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ quotationId?: string | string[] }>;
}) {
  const ctx = await requireUser();
  const { quotationId } = await searchParams;
  if (typeof quotationId !== 'string') notFound();

  const quotation = await loadQuotationOr404(ctx, quotationId);
  const draft = await getProjectDraft(ctx, quotationId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof DomainError) return error;
    throw error;
  });

  return (
    <section className="flex flex-col gap-6 py-8">
      <h1 className="text-2xl font-semibold">New project</h1>
      {draft instanceof DomainError ? (
        <p>{draft.message}.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            Projects arrive in a later release. This is what the project will start from.
          </p>
          <dl className="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
            <Item label="Quotation">{draft.quotationNumber}</Item>
            <Item label="Client">{quotation.client.name}</Item>
            <Item label="Services">{quotation.services.map((s) => s.name).join(', ')}</Item>
            <Item label="Revenue">{formatMoney(draft.revenueMinor, draft.currency)}</Item>
            <Item label="PO received on">{formatDate(draft.poReceivedDate)}</Item>
            <Item label="Owner">{quotation.owner.name}</Item>
          </dl>
        </>
      )}
      <Link className="underline-offset-4 hover:underline" href={`/quotations/${quotation.id}`}>
        Back to {quotation.number}
      </Link>
    </section>
  );
}
