'use client';

import type { ColumnMappingEntry } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { applyResult } from '@/lib/apply-result';
import { IMPORT_FIELD_LABELS } from '@/lib/import-labels';
import { editImportRowAction } from '../actions';

/** Review step "fix in place" (M10b): edit a row's raw cell values, re-validated on save. */
export function RowEditDialog({
  rowId,
  rowNumber,
  original,
  columns,
  open,
  onOpenChange,
}: {
  rowId: string;
  rowNumber: number;
  original: Record<string, unknown>;
  columns: ColumnMappingEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const mapped = columns.filter((c) => c.field);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(mapped.map((c) => [c.header, String(original[c.header] ?? '')])),
  );

  function save() {
    startTransition(async () => {
      const result = await editImportRowAction({ rowId, original: values });
      if (applyResult(result, undefined, `Row ${rowNumber} updated`)) {
        onOpenChange(false);
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Row {rowNumber}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {mapped.map((column) => (
            <div key={column.header} className="flex flex-col gap-1">
              <Label htmlFor={`row-${rowId}-${column.header}`}>
                {column.field ? IMPORT_FIELD_LABELS[column.field] : column.header}
              </Label>
              <Input
                id={`row-${rowId}-${column.header}`}
                value={values[column.header] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [column.header]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            Save row
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
