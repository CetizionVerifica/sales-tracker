'use client';

import type {
  ColumnMappingEntry,
  DateFormatValue,
  ImportFieldValue,
} from '@sales-tracker/core/schemas';
import { DATE_FORMATS, IMPORT_FIELDS, REQUIRED_IMPORT_FIELDS } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Panel } from '@/components/charts/Panel';
import { applyResult } from '@/lib/apply-result';
import { IMPORT_DATE_FORMAT_LABELS, IMPORT_FIELD_LABELS } from '@/lib/import-labels';
import { updateImportMappingAction } from '../actions';

const NOT_IMPORTED = '__not_imported__';
const DATE_FIELDS = new Set<ImportFieldValue>(['receivedDate', 'proposalSentDate']);
const REQUIRED = new Set<ImportFieldValue>(REQUIRED_IMPORT_FIELDS);

interface SheetRange {
  sheetName: string;
  headerRow: number;
  dataStartRow: number;
  dataEndRow: number;
}

/** The Columns step (M10b wizard): confirm which file column is which Enquiry field. */
export function MappingPanel({
  batchId,
  sheetConfig,
  columns: initialColumns,
  samples,
}: {
  batchId: string;
  sheetConfig: SheetRange;
  columns: ColumnMappingEntry[];
  samples: Record<number, string[]>;
}) {
  const router = useRouter();
  const [range, setRange] = useState(sheetConfig);
  const [columns, setColumns] = useState(initialColumns);
  const [pending, startTransition] = useTransition();

  function updateColumn(index: number, patch: Partial<ColumnMappingEntry>) {
    setColumns((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function setField(index: number, field: ImportFieldValue | null) {
    updateColumn(index, {
      field,
      dateFormat: field && DATE_FIELDS.has(field) ? 'DD/MM/YYYY' : undefined,
      separator: field === 'services' ? ',' : undefined,
    });
  }

  const missingRequired = [...REQUIRED].filter((field) => !columns.some((c) => c.field === field));

  function save() {
    startTransition(async () => {
      const result = await updateImportMappingAction({ batchId, sheetConfig: range, columns });
      if (applyResult(result, undefined, 'Mapping saved')) router.refresh();
    });
  }

  return (
    <Panel
      title="Columns"
      description="Match each column in the file to a field. Unmapped columns are ignored."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="header-row">Header row</Label>
            <Input
              id="header-row"
              type="number"
              min={1}
              className="w-24"
              value={range.headerRow}
              onChange={(e) => setRange({ ...range, headerRow: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="data-start">Data starts at row</Label>
            <Input
              id="data-start"
              type="number"
              min={1}
              className="w-24"
              value={range.dataStartRow}
              onChange={(e) => setRange({ ...range, dataStartRow: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="data-end">Data ends at row</Label>
            <Input
              id="data-end"
              type="number"
              min={1}
              className="w-24"
              value={range.dataEndRow}
              onChange={(e) => setRange({ ...range, dataEndRow: Number(e.target.value) || 1 })}
            />
          </div>
        </div>

        <div className="overflow-x-auto rounded-[var(--radius)] border">
          <table className="w-full caption-bottom text-sm">
            <thead className="bg-muted">
              <tr className="border-b">
                <th scope="col" className="h-10 px-3 text-left text-[13px] font-medium">
                  File column
                </th>
                <th scope="col" className="h-10 px-3 text-left text-[13px] font-medium">
                  Sample values
                </th>
                <th scope="col" className="h-10 px-3 text-left text-[13px] font-medium">
                  Field
                </th>
                <th scope="col" className="h-10 px-3 text-left text-[13px] font-medium">
                  Format / separator
                </th>
              </tr>
            </thead>
            <tbody>
              {columns.map((entry, index) => (
                <tr key={entry.column} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium whitespace-nowrap">
                    {entry.header || <span className="text-muted-foreground">(blank)</span>}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-[13px]">
                    {(samples[entry.column] ?? []).join(' · ') || '—'}
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      value={entry.field ?? NOT_IMPORTED}
                      onValueChange={(value) =>
                        setField(index, value === NOT_IMPORTED ? null : (value as ImportFieldValue))
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-48"
                        aria-label={`Field for ${entry.header}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NOT_IMPORTED}>Not imported</SelectItem>
                        {IMPORT_FIELDS.map((field) => (
                          <SelectItem key={field} value={field}>
                            {IMPORT_FIELD_LABELS[field]}
                            {REQUIRED.has(field) ? ' *' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    {entry.field && DATE_FIELDS.has(entry.field) && (
                      <Select
                        value={entry.dateFormat ?? 'DD/MM/YYYY'}
                        onValueChange={(value) =>
                          updateColumn(index, { dateFormat: value as DateFormatValue })
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-48"
                          aria-label={`Date format for ${entry.header}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DATE_FORMATS.map((format) => (
                            <SelectItem key={format} value={format}>
                              {IMPORT_DATE_FORMAT_LABELS[format]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {entry.field === 'services' && (
                      <Input
                        aria-label={`Separator for ${entry.header}`}
                        className="w-20"
                        value={entry.separator ?? ','}
                        onChange={(e) => updateColumn(index, { separator: e.target.value || ',' })}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {missingRequired.length > 0 && (
          <p className="text-warning text-[13px]" role="status">
            Not yet mapped: {missingRequired.map((f) => IMPORT_FIELD_LABELS[f]).join(', ')}
          </p>
        )}

        <div className="flex justify-end">
          <Button onClick={save} disabled={pending}>
            Save mapping
          </Button>
        </div>
      </div>
    </Panel>
  );
}
