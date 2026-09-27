'use client';

import { SheetLauncher } from '@/components/layout/SheetLauncher';
import type { QuotationFormOptions } from './form-options';
import { QuotationForm, type QuotationFormValues } from './QuotationForm';

/** "Create quotation" on a converted enquiry; also opens from `?newQuotation=1`. */
export function CreateQuotationButton({
  enquiryNumber,
  client,
  initial,
  options,
  today,
}: {
  enquiryNumber: string;
  client: string;
  initial: QuotationFormValues;
  options: QuotationFormOptions;
  today: string;
}) {
  return (
    <SheetLauncher param="newQuotation" label="Create quotation">
      {(open, onOpenChange) => (
        <QuotationForm
          enquiryNumber={enquiryNumber}
          client={client}
          initial={initial}
          options={options}
          today={today}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </SheetLauncher>
  );
}

/** "Edit" on the quotation page; also opens from `?edit=1`. */
export function EditQuotationButton({
  quotation,
  closed,
  client,
  initial,
  options,
  today,
}: {
  quotation: { id: string; number: string };
  closed: boolean;
  client: string;
  initial: QuotationFormValues;
  options: QuotationFormOptions;
  today: string;
}) {
  return (
    <SheetLauncher param="edit" label="Edit" variant="outline">
      {(open, onOpenChange) => (
        <QuotationForm
          quotation={quotation}
          closed={closed}
          client={client}
          initial={initial}
          options={options}
          today={today}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </SheetLauncher>
  );
}
