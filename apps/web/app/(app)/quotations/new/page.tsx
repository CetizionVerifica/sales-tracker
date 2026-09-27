import { can, DomainError, getQuotationDraft, NotFoundError } from '@sales-tracker/core';
import { todayInIST, toCalendarDateString } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Forbidden } from '@/components/Forbidden';
import { requireUser } from '@/lib/auth';
import { loadEnquiryOr404 } from '../../enquiries/load';
import { loadQuotationFormOptions } from '../form-options';
import { QuotationForm } from '../QuotationForm';

export const metadata = { title: 'New quotation · Sales Tracker' };

/** Quotations start from a converted enquiry (M6 Decision 1), pre-filled from its draft. */
export default async function NewQuotationPage({
  searchParams,
}: {
  searchParams: Promise<{ enquiryId?: string | string[] }>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'create', 'quotation')) return <Forbidden />;
  const { enquiryId } = await searchParams;
  if (typeof enquiryId !== 'string') notFound();

  const enquiry = await loadEnquiryOr404(ctx, enquiryId);
  const draft = await getQuotationDraft(ctx, enquiryId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof DomainError) return error;
    throw error;
  });
  if (draft instanceof DomainError) {
    return (
      <section className="flex flex-col gap-4 py-8">
        <h1 className="text-2xl font-semibold">New quotation</h1>
        <p>{draft.message}.</p>
        <Link className="underline-offset-4 hover:underline" href={`/enquiries/${enquiry.id}`}>
          Back to {enquiry.number}
        </Link>
      </section>
    );
  }
  const options = await loadQuotationFormOptions(ctx);

  return (
    <section className="flex flex-col gap-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold">New quotation</h1>
        <p className="text-muted-foreground text-sm">
          From enquiry{' '}
          <Link className="underline-offset-4 hover:underline" href={`/enquiries/${enquiry.id}`}>
            {draft.enquiryNumber}
          </Link>
        </p>
      </div>
      <QuotationForm
        client={enquiry.client.name}
        options={options}
        today={toCalendarDateString(todayInIST())}
        initial={{
          enquiryId: draft.enquiryId,
          quotationDate: toCalendarDateString(draft.quotationDate),
          amount: '',
          currency: options.currencies.includes('INR') ? 'INR' : (options.currencies[0] ?? 'INR'),
          sectorId: draft.sectorId,
          serviceIds: draft.serviceIds,
          nextFollowUpDate: '',
          description: '',
          lastFollowUpHighlights: '',
          ownerId: draft.ownerId,
        }}
      />
    </section>
  );
}
