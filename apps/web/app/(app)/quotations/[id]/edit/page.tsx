import { redirect } from 'next/navigation';

/** Editing opens in a side sheet on the quotation (UI guide §4.3); old links land there. */
export default async function EditQuotationPage({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/quotations/${(await params).id}?edit=1`);
}
