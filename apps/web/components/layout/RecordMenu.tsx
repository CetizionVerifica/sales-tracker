'use client';

import { useState } from 'react';
import { RowActions } from '@/components/data/RowActions';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import type { ActionResult } from '@/lib/action-core';

export interface RecordMenuItem {
  label: string;
  /** Confirmation that names the record ("Delete QUO-0087?", UI guide §5). */
  title: string;
  description: string;
  /** Toast with the same verb as the item. */
  success: string;
  run: () => Promise<ActionResult<unknown>>;
  destructive?: boolean;
}

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
      {items.map((item, index) => (
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
      ))}
    </>
  );
}
