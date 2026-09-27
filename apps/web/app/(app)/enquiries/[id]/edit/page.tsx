import { redirect } from 'next/navigation';

/** Editing opens in a side sheet on the enquiry (UI guide §4.3); old links land there. */
export default async function EditEnquiryPage({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/enquiries/${(await params).id}?edit=1`);
}
