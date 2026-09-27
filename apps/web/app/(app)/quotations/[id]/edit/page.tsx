import { can, quotationResource } from '@sales-tracker/core';
import { toAmountString, todayInIST, toCalendarDateString } from '@sales-tracker/core/schemas';
import { Forbidden } from '@/components/Forbidden';
import { requireUser } from '@/lib/auth';
import { isOpenQuotation } from '@/lib/quotation-labels';
import { loadQuotationFormOptions } from '../../form-options';
import { loadQuotationOr404 } from '../../load';
import { QuotationForm } from '../../QuotationForm';

export const metadata = { title: 'Edit quotation · Sales Tracker' };

export default async function EditQuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const quotation = await loadQuotationOr404(ctx, (await params).id);
  if (quotation.deletedAt || !can(ctx.user, 'update', quotationResource(quotation))) {
    return <Forbidden />;
  }
  const options = await loadQuotationFormOptions(ctx, quotation);

  return (
    <section className="flex flex-col gap-6 py-8">
      <h1 className="text-2xl font-semibold">Edit {quotation.number}</h1>
      <QuotationForm
        quotation={{ id: quotation.id, number: quotation.number }}
        closed={!isOpenQuotation(quotation.status)}
        client={quotation.client.name}
        options={options}
        today={toCalendarDateString(todayInIST())}
        initial={{
          enquiryId: quotation.enquiryId,
          quotationDate: toCalendarDateString(quotation.quotationDate),
          amount: toAmountString(quotation.amountMinor, quotation.currency),
          currency: quotation.currency,
          sectorId: quotation.sectorId,
          serviceIds: quotation.services.map((s) => s.id),
          nextFollowUpDate: quotation.nextFollowUpDate
            ? toCalendarDateString(quotation.nextFollowUpDate)
            : '',
          description: quotation.description ?? '',
          lastFollowUpHighlights: quotation.lastFollowUpHighlights ?? '',
          ownerId: quotation.ownerId,
        }}
      />
    </section>
  );
}
