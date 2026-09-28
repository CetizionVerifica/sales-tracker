'use client';

import {
  ENQUIRY_SOURCES,
  ENQUIRY_SOURCE_LABELS,
  type EnquirySourceValue,
  type ReferenceFieldValue,
  type ValueMappingEntry,
} from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Panel } from '@/components/charts/Panel';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { applyResult } from '@/lib/apply-result';
import { IMPORT_FIELD_LABELS } from '@/lib/import-labels';
import { updateImportValueMappingAction } from '../actions';

const AUTO = '__auto__';
const BLANK = '__blank__';
const CREATE = '__create__';

interface Choice {
  action: 'map' | 'create' | 'blank' | 'auto';
  targetId?: string;
  targetEnumValue?: EnquirySourceValue;
}

function keyOf(field: string, value: string) {
  return `${field}:${value}`;
}

/** The Values step (M10b wizard): resolve distinct file values with no exact-name match. */
export function ValuesPanel({
  batchId,
  distinctValues,
  savedMappings,
  clients,
  sectors,
  services,
  owners,
  canCreateClient,
}: {
  batchId: string;
  distinctValues: { field: ReferenceFieldValue; values: { value: string; count: number }[] }[];
  savedMappings: ValueMappingEntry[];
  clients: { id: string; name: string }[];
  sectors: { id: string; name: string }[];
  services: { id: string; name: string }[];
  owners: { id: string; name: string }[];
  canCreateClient: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [choices, setChoices] = useState<Map<string, Choice>>(() => {
    const map = new Map<string, Choice>();
    for (const entry of savedMappings) {
      map.set(keyOf(entry.field, entry.sourceValue), {
        action: entry.action,
        targetId: entry.targetId,
        targetEnumValue: entry.targetEnumValue,
      });
    }
    return map;
  });

  if (distinctValues.length === 0) return null;

  const optionsFor = (field: ReferenceFieldValue) =>
    field === 'client'
      ? clients
      : field === 'sector'
        ? sectors
        : field === 'services'
          ? services
          : field === 'owner'
            ? owners
            : [];

  function setChoice(field: string, value: string, choice: Choice) {
    setChoices((prev) => new Map(prev).set(keyOf(field, value), choice));
  }

  function selectValueFor(field: string, value: string): string {
    const choice = choices.get(keyOf(field, value));
    if (!choice || choice.action === 'auto') return AUTO;
    if (choice.action === 'blank') return BLANK;
    if (choice.action === 'create') return CREATE;
    return choice.targetId ?? choice.targetEnumValue ?? AUTO;
  }

  function onSelect(field: ReferenceFieldValue, value: string, selected: string) {
    if (selected === AUTO) {
      setChoice(field, value, { action: 'auto' });
    } else if (selected === BLANK) {
      setChoice(field, value, { action: 'blank' });
    } else if (selected === CREATE) {
      setChoice(field, value, { action: 'create' });
    } else if (field === 'source') {
      setChoice(field, value, { action: 'map', targetEnumValue: selected as EnquirySourceValue });
    } else {
      setChoice(field, value, { action: 'map', targetId: selected });
    }
  }

  function save() {
    const values: ValueMappingEntry[] = [];
    for (const [key, choice] of choices) {
      if (choice.action === 'auto') continue;
      const [field, ...rest] = key.split(':');
      values.push({
        field: field as ReferenceFieldValue,
        sourceValue: rest.join(':'),
        action: choice.action,
        targetId: choice.targetId,
        targetEnumValue: choice.targetEnumValue,
      });
    }
    startTransition(async () => {
      const result = await updateImportValueMappingAction({ batchId, values });
      if (applyResult(result, undefined, 'Value mappings saved')) router.refresh();
    });
  }

  return (
    <Panel
      title="Values"
      description="Map each distinct value found in the file. Values that already match exactly need no action."
    >
      <div className="flex flex-col gap-6">
        {distinctValues.map(({ field, values }) => (
          <div key={field} className="flex flex-col gap-2">
            <h3 className="text-[13px] font-medium">{IMPORT_FIELD_LABELS[field]}</h3>
            <div className="overflow-x-auto rounded-[var(--radius)] border">
              <table className="w-full caption-bottom text-sm">
                <thead className="bg-muted">
                  <tr className="border-b">
                    <th scope="col" className="h-9 px-3 text-left text-[13px] font-medium">
                      File value
                    </th>
                    <th scope="col" className="num h-9 px-3 text-right text-[13px] font-medium">
                      Rows
                    </th>
                    <th scope="col" className="h-9 px-3 text-left text-[13px] font-medium">
                      Matches
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {values.map(({ value, count }) => (
                    <tr key={value} className="border-b last:border-0">
                      <td className="px-3 py-2">{value}</td>
                      <td className="num px-3 py-2 text-right">{count}</td>
                      <td className="px-3 py-2">
                        <Select
                          value={selectValueFor(field, value)}
                          onValueChange={(selected) => onSelect(field, value, selected)}
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-56"
                            aria-label={`Match for ${value}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={AUTO}>Match automatically</SelectItem>
                            {field === 'owner' && (
                              <SelectItem value={BLANK}>Leave blank</SelectItem>
                            )}
                            {field === 'client' && canCreateClient && (
                              <SelectItem value={CREATE}>Create a new client</SelectItem>
                            )}
                            {field === 'source'
                              ? ENQUIRY_SOURCES.map((source) => (
                                  <SelectItem key={source} value={source}>
                                    {ENQUIRY_SOURCE_LABELS[source]}
                                  </SelectItem>
                                ))
                              : optionsFor(field).map((option) => (
                                  <SelectItem key={option.id} value={option.id}>
                                    {option.name}
                                  </SelectItem>
                                ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <div className="flex justify-end">
          <Button onClick={save} disabled={pending}>
            Save value mappings
          </Button>
        </div>
      </div>
    </Panel>
  );
}
