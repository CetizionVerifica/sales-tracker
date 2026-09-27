'use client';

import { SheetLauncher } from '@/components/layout/SheetLauncher';
import { EnquiryForm, type EnquiryFormValues } from './EnquiryForm';
import type { EnquiryFormOptions } from './form-options';

/** "New enquiry" in the list header; also opens from `?new=1` (the + New menu). */
export function NewEnquiryButton({
  options,
  today,
}: {
  options: EnquiryFormOptions;
  today: string;
}) {
  return (
    <SheetLauncher param="new" label="New enquiry">
      {(open, onOpenChange) => (
        <EnquiryForm options={options} today={today} open={open} onOpenChange={onOpenChange} />
      )}
    </SheetLauncher>
  );
}

/** "Edit" on the enquiry page; also opens from `?edit=1`. */
export function EditEnquiryButton({
  enquiry,
  options,
  today,
}: {
  enquiry: EnquiryFormValues;
  options: EnquiryFormOptions;
  today: string;
}) {
  return (
    <SheetLauncher param="edit" label="Edit" variant="outline">
      {(open, onOpenChange) => (
        <EnquiryForm
          enquiry={enquiry}
          options={options}
          today={today}
          open={open}
          onOpenChange={onOpenChange}
        />
      )}
    </SheetLauncher>
  );
}
