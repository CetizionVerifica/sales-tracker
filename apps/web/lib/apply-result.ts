'use client';

import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import type { ActionResult } from './action-core.ts';

/**
 * Shows a server-action result: field errors go onto the form inputs, other errors to a
 * toast. Returns true on success (a type guard, so `result.data` is typed afterwards).
 */
export function applyResult<T, F extends FieldValues>(
  result: ActionResult<T>,
  form?: UseFormReturn<F>,
  success?: string,
): result is { ok: true; data: T } {
  if (result.ok) {
    if (success) toast.success(success);
    return true;
  }
  let placed = false;
  if (form && result.fieldErrors) {
    for (const [field, messages] of Object.entries(result.fieldErrors)) {
      if (messages[0] && field in form.getValues()) {
        form.setError(field as Path<F>, { message: messages[0] });
        placed = true;
      }
    }
  }
  if (!placed) toast.error(result.error);
  return false;
}
