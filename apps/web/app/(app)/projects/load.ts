import { getProject, NotFoundError, type Ctx } from '@sales-tracker/core';
import { notFound } from 'next/navigation';

/** getProject, with "not found or not yours" shown as the 404 page (M4 Decision 7). */
export function loadProjectOr404(ctx: Ctx, id: string) {
  return getProject(ctx, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
}
