'use server';

import {
  getClientTimeline,
  logFollowUp,
  restoreFollowUp,
  softDeleteFollowUp,
  updateFollowUp,
} from '@sales-tracker/core';
import {
  clientTimelineSchema,
  createFollowUpSchema,
  followUpIdActionSchema,
  updateFollowUpActionSchema,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

/** Refreshes the pages that show this follow-up: its client, and its enquiry. */
function done<T extends { id: string; clientId: string; entityType: string; entityId: string }>(
  followUp: T,
) {
  revalidatePath(`/clients/${followUp.clientId}`);
  if (followUp.entityType === 'ENQUIRY') revalidatePath(`/enquiries/${followUp.entityId}`);
  return { id: followUp.id };
}

export const logFollowUpAction = action(createFollowUpSchema, async (ctx, input) =>
  done(await logFollowUp(ctx, input)),
);

export const updateFollowUpAction = action(updateFollowUpActionSchema, async (ctx, { id, data }) =>
  done(await updateFollowUp(ctx, id, data)),
);

export const deleteFollowUpAction = action(followUpIdActionSchema, async (ctx, { id }) =>
  done(await softDeleteFollowUp(ctx, id)),
);

export const restoreFollowUpAction = action(followUpIdActionSchema, async (ctx, { id }) =>
  done(await restoreFollowUp(ctx, id)),
);

/** "Load more": the next page of a timeline after a cursor. */
export const loadTimelineAction = action(clientTimelineSchema, (ctx, input) =>
  getClientTimeline(ctx, input),
);
