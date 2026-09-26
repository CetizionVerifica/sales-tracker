'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ComponentProps } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { ActionResult } from '@/lib/action-core';
import { applyResult } from '@/lib/apply-result';

/** A button that asks for confirmation, runs a server action, and refreshes the page. */
export function ConfirmButton({
  label,
  title,
  description,
  confirmLabel = label,
  success,
  run,
  variant = 'outline',
}: {
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  success: string;
  run: () => Promise<ActionResult<unknown>>;
  variant?: ComponentProps<typeof Button>['variant'];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size="sm">
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              startTransition(async () => {
                if (applyResult(await run(), undefined, success)) {
                  setOpen(false);
                  router.refresh();
                }
              });
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
