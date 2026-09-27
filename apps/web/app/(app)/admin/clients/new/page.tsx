import { redirect } from 'next/navigation';

/** New clients open in a side sheet over the list (UI guide §4.3); old links land there. */
export default function NewClientPage() {
  redirect('/admin/clients?new=1');
}
