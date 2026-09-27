import { can } from '@sales-tracker/core';
import { todayInIST, toCalendarDateString } from '@sales-tracker/core/schemas';
import { Forbidden } from '@/components/Forbidden';
import { requireUser } from '@/lib/auth';
import { EnquiryForm } from '../EnquiryForm';
import { loadEnquiryFormOptions } from '../form-options';

export const metadata = { title: 'New enquiry · Sales Tracker' };

export default async function NewEnquiryPage() {
  const ctx = await requireUser();
  if (!can(ctx.user, 'create', 'enquiry')) return <Forbidden />;
  const options = await loadEnquiryFormOptions(ctx);

  return (
    <section className="flex flex-col gap-6 py-8">
      <h1 className="text-2xl font-semibold">New enquiry</h1>
      <EnquiryForm options={options} today={toCalendarDateString(todayInIST())} />
    </section>
  );
}
