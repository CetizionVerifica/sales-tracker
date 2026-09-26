'use server';

import {
  addContact,
  createClient,
  removeContact,
  restoreClient,
  setPrimaryContact,
  softDeleteClient,
  updateClient,
  updateContact,
} from '@sales-tracker/core';
import {
  contactIdActionSchema,
  contactSchema,
  contactUpdateActionSchema,
  createClientSchema,
  idOnlySchema,
  updateClientSchema,
  withId,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

function done<T>(value: T, clientId?: string): T {
  revalidatePath('/admin/clients');
  if (clientId) revalidatePath(`/admin/clients/${clientId}`);
  return value;
}

export const createClientAction = action(createClientSchema, async (ctx, input) => {
  const client = await createClient(ctx, input);
  return done({ id: client.id });
});

export const updateClientAction = action(withId(updateClientSchema), async (ctx, { id, data }) =>
  done({ id: (await updateClient(ctx, id, data)).id }, id),
);

export const deleteClientAction = action(idOnlySchema, async (ctx, { id }) =>
  done({ id: (await softDeleteClient(ctx, id)).id }, id),
);

export const restoreClientAction = action(idOnlySchema, async (ctx, { id }) =>
  done({ id: (await restoreClient(ctx, id)).id }, id),
);

export const addContactAction = action(withId(contactSchema), async (ctx, { id, data }) =>
  done({ id: (await addContact(ctx, id, data)).id }, id),
);

export const updateContactAction = action(
  contactUpdateActionSchema,
  async (ctx, { id, data, clientId }) =>
    done({ id: (await updateContact(ctx, id, data)).id }, clientId),
);

export const removeContactAction = action(contactIdActionSchema, async (ctx, { id, clientId }) =>
  done({ id: (await removeContact(ctx, id)).id }, clientId),
);

export const setPrimaryContactAction = action(
  contactIdActionSchema,
  async (ctx, { id, clientId }) => done({ id: (await setPrimaryContact(ctx, id)).id }, clientId),
);
