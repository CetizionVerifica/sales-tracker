import { DomainError, getQuotationDraft, NotFoundError } from '@sales-tracker/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireUser } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadEnquiryOr404 } from '../../enquiries/load';

export const metadata = { title: 'New quotation · Sales Tracker' };

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Placeholder until M6 builds the quotation form: shows the draft a converted enquiry
 * hands over (getQuotationDraft), so the M4 hand-off can be tested end to end.
 */
export default async function NewQuotationPage({
  searchParams,
}: {
  searchParams: Promise<{ enquiryId?: string | string[] }>;
}) {
  const ctx = await requireUser();
  const { enquiryId } = await searchParams;
  if (typeof enquiryId !== 'string') notFound();

  const enquiry = await loadEnquiryOr404(ctx, enquiryId);
  const draft = await getQuotationDraft(ctx, enquiryId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof DomainError) return error;
    throw error;
  });

  return (
    <section className="flex flex-col gap-6 py-8">
      <h1 className="text-2xl font-semibold">New quotation</h1>
      {draft instanceof DomainError ? (
        <p>{draft.message}.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            Quotations arrive in the next release. This is what the new quotation will start from:
          </p>
          <dl className="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
            <Item label="From enquiry">{draft.enquiryNumber}</Item>
            <Item label="Client">{enquiry.client.name}</Item>
            <Item label="Sector">{enquiry.sector.name}</Item>
            <Item label="Services">
              {enquiry.services
                .filter((s) => draft.serviceIds.includes(s.id))
                .map((s) => s.name)
                .join(', ')}
            </Item>
            <Item label="Owner">{enquiry.owner.name}</Item>
            <Item label="Quotation date">{formatDate(draft.quotationDate)}</Item>
          </dl>
        </>
      )}
      <Link className="underline-offset-4 hover:underline" href={`/enquiries/${enquiry.id}`}>
        Back to {enquiry.number}
      </Link>
    </section>
  );
}
