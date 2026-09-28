'use client';

import { useState } from 'react';
import { RowActions } from '@/components/data/RowActions';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { ActionResult } from '@/lib/action-core';

export type RecordMenuItem = {
  label: string;
  /** Confirmation that names the record ("Delete QUO-0087?", UI guide §5). */
  title: string;
  description: string;
  destructive?: boolean;
} & (
  | {
      /** Toast with the same verb as the item. */
      success: string;
      run: () => Promise<ActionResult<unknown>>;
      blocked?: false;
    }
  /**
   * The action exists but cannot run on this record now (M9: a project with POs): the
   * dialog explains why, with nothing to confirm.
   */
  | { blocked: true }
);

/** The ⋯ menu in a detail page header: secondary actions, each behind a confirmation. */
export function RecordMenu({ label, items }: { label: string; items: RecordMenuItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <RowActions
        label={label}
        actions={items.map((item, index) => ({
          label: item.label,
          destructive: item.destructive,
          onSelect: () => setOpen(index),
        }))}
      />
      {items.map((item, index) =>
        item.blocked ? (
          <AlertDialog
            key={item.label}
            open={open === index}
            onOpenChange={(next) => !next && setOpen(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{item.title}</AlertDialogTitle>
                <AlertDialogDescription>{item.description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Close</AlertDialogCancel>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <ConfirmDialog
            key={item.label}
            open={open === index}
            onOpenChange={(next) => !next && setOpen(null)}
            variant={item.destructive ? 'destructive' : 'outline'}
            label={item.label}
            title={item.title}
            description={item.description}
            success={item.success}
            run={item.run}
          />
        ),
      )}
    </>
  );
}
