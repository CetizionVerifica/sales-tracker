import { can, enquiryResource } from '@sales-tracker/core';
import { todayInIST, toCalendarDateString } from '@sales-tracker/core/schemas';
import { Forbidden } from '@/components/Forbidden';
import { requireUser } from '@/lib/auth';
import { EnquiryForm } from '../../EnquiryForm';
import { loadEnquiryFormOptions } from '../../form-options';
import { loadEnquiryOr404 } from '../../load';

export const metadata = { title: 'Edit enquiry · Sales Tracker' };

export default async function EditEnquiryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const enquiry = await loadEnquiryOr404(ctx, (await params).id);
  if (enquiry.deletedAt || !can(ctx.user, 'update', enquiryResource(enquiry))) {
    return <Forbidden />;
  }
  const options = await loadEnquiryFormOptions(ctx, enquiry);

  return (
    <section className="flex flex-col gap-6 py-8">
      <h1 className="text-2xl font-semibold">Edit {enquiry.number}</h1>
      <EnquiryForm
        options={options}
        today={toCalendarDateString(todayInIST())}
        enquiry={{
          id: enquiry.id,
          number: enquiry.number,
          clientId: enquiry.clientId,
          sectorId: enquiry.sectorId,
          serviceIds: enquiry.services.map((s) => s.id),
          receivedDate: toCalendarDateString(enquiry.receivedDate),
          proposalSentDate: enquiry.proposalSentDate
            ? toCalendarDateString(enquiry.proposalSentDate)
            : '',
          source: enquiry.source,
          sourceDetail: enquiry.sourceDetail ?? '',
          description: enquiry.description ?? '',
          ownerId: enquiry.ownerId,
        }}
      />
    </section>
  );
}
