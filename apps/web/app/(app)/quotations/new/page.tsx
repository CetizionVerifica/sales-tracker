import { notFound, redirect } from 'next/navigation';

/**
 * Quotations start from a converted enquiry (M6 Decision 1) and open in a side sheet on
 * it (UI guide §4.3); old /quotations/new?enquiryId= links land there.
 */
export default async function NewQuotationPage({
  searchParams,
}: {
  searchParams: Promise<{ enquiryId?: string | string[] }>;
}) {
  const { enquiryId } = await searchParams;
  if (typeof enquiryId !== 'string') notFound();
  redirect(`/enquiries/${enquiryId}?newQuotation=1`);
}
