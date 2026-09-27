'use server';

import {
  confirmExtraction,
  restoreDocument,
  retryExtraction,
  softDeleteDocument,
  type DocumentView,
} from '@sales-tracker/core';
import { confirmExtractionSchema, idOnlySchema } from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

/** Refreshes the pages that show a document; results carry ids only. */
function done(document: DocumentView) {
  revalidatePath(`/documents/${document.id}/review`);
  if (document.kind === 'QUOTATION') {
    revalidatePath(`/quotations/${document.entityId}`);
    revalidatePath('/quotations');
  }
  return { id: document.id, entityId: document.entityId };
}

export const confirmExtractionAction = action(confirmExtractionSchema, async (ctx, input) =>
  done(await confirmExtraction(ctx, input)),
);

export const retryExtractionAction = action(idOnlySchema, async (ctx, { id }) =>
  done(await retryExtraction(ctx, id)),
);

export const deleteDocumentAction = action(idOnlySchema, async (ctx, { id }) =>
  done(await softDeleteDocument(ctx, id)),
);

export const restoreDocumentAction = action(idOnlySchema, async (ctx, { id }) =>
  done(await restoreDocument(ctx, id)),
);
