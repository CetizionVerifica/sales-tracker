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

/**
 * A button that asks for confirmation, runs a server action, and refreshes the page. Titles
 * name the record ("Delete ENQ-0142?", UI guide §5); the toast uses the button's verb.
 */
export function ConfirmDialog({
  label,
  title,
  description,
  confirmLabel = label,
  success,
  run,
  variant = 'outline',
  open: controlledOpen,
  onOpenChange,
}: {
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  success: string;
  run: () => Promise<ActionResult<unknown>>;
  variant?: ComponentProps<typeof Button>['variant'];
  /** Controlled from elsewhere (a row's ⋯ menu): no trigger button is rendered. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (next: boolean) => (controlled ? onOpenChange?.(next) : setOwnOpen(next));
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <AlertDialogTrigger asChild>
          <Button variant={variant} size="sm">
            {label}
          </Button>
        </AlertDialogTrigger>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className={
              variant === 'destructive'
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : undefined
            }
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
