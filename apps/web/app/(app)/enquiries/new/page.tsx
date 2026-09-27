import { redirect } from 'next/navigation';

/** New enquiries open in a side sheet over the list (UI guide §4.3); old links land there. */
export default function NewEnquiryPage() {
  redirect('/enquiries?new=1');
}
