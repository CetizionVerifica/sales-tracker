'use server';

import {
  convertEnquiry,
  createClient,
  createEnquiry,
  markEnquiryLost,
  restoreEnquiry,
  softDeleteEnquiry,
  updateEnquiry,
} from '@sales-tracker/core';
import {
  convertEnquirySchema,
  createEnquirySchema,
  enquiryIdActionSchema,
  markEnquiryLostSchema,
  quickClientSchema,
  updateEnquiryActionSchema,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

function done<T>(value: T, enquiryId?: string): T {
  revalidatePath('/enquiries');
  if (enquiryId) revalidatePath(`/enquiries/${enquiryId}`);
  return value;
}

export const createEnquiryAction = action(createEnquirySchema, async (ctx, input) =>
  done({ id: (await createEnquiry(ctx, input)).id }),
);

export const updateEnquiryAction = action(updateEnquiryActionSchema, async (ctx, { id, data }) =>
  done({ id: (await updateEnquiry(ctx, id, data)).id }, id),
);

export const convertEnquiryAction = action(convertEnquirySchema, async (ctx, input) =>
  done({ id: (await convertEnquiry(ctx, input)).enquiry.id }, input.id),
);

export const markEnquiryLostAction = action(markEnquiryLostSchema, async (ctx, input) =>
  done({ id: (await markEnquiryLost(ctx, input)).id }, input.id),
);

export const deleteEnquiryAction = action(enquiryIdActionSchema, async (ctx, { id }) =>
  done({ id: (await softDeleteEnquiry(ctx, id)).id }, id),
);

export const restoreEnquiryAction = action(enquiryIdActionSchema, async (ctx, { id }) =>
  done({ id: (await restoreEnquiry(ctx, id)).id }, id),
);

/** "New client" from the enquiry form (Sales may create clients: M3 Decision 11). */
export const createClientFromEnquiryAction = action(quickClientSchema, async (ctx, input) => {
  const { contactName, contactEmail, contactPhone, ...fields } = input;
  const client = await createClient(ctx, {
    ...fields,
    contacts: contactName
      ? [{ name: contactName, email: contactEmail, phone: contactPhone, isPrimary: true }]
      : [],
  });
  revalidatePath('/admin/clients');
  return { id: client.id, name: client.name, sectorId: client.sectorId };
});
