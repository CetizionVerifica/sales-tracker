'use client';

import { useState, type FormEventHandler, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Loader2 } from 'lucide-react';

/**
 * Create and edit forms open in a 560px right-side sheet (UI guide §4.3): single-column
 * body, sticky footer with [Cancel] left of the primary button that names the action, and
 * a confirmation before closing with unsaved changes.
 */
export function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  submitting,
  dirty,
  onSubmit,
  children,
  formError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Verb + object: "Save enquiry", "Create user". */
  submitLabel: string;
  submitting: boolean;
  /** Whether closing would lose changes. */
  dirty: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
  /** A server error shown as a destructive alert at the top (guide §4.3). */
  formError?: string | null;
}) {
  const [confirming, setConfirming] = useState(false);

  function requestClose(next: boolean) {
    if (!next && dirty && !submitting) {
      setConfirming(true);
      return;
    }
    onOpenChange(next);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={requestClose}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[560px]">
          <SheetHeader className="border-b px-6 py-4">
            <SheetTitle className="text-base">{title}</SheetTitle>
            {description && <SheetDescription>{description}</SheetDescription>}
          </SheetHeader>
          <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {formError && (
                <div
                  role="alert"
                  className="bg-destructive-soft text-destructive mb-4 rounded-[var(--radius-control)] border px-3 py-2"
                >
                  {formError}
                </div>
              )}
              {children}
            </div>
            <div className="bg-card sticky bottom-0 flex justify-end gap-2 border-t px-6 py-3">
              <Button type="button" variant="outline" onClick={() => requestClose(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" aria-hidden />}
                {submitLabel}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              What you entered in this form will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                onOpenChange(false);
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
