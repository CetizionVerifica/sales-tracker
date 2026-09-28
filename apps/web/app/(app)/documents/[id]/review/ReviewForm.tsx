'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  formatMoney,
  isIsoCurrency,
  parseAmount,
  reviewExtractionFormSchema,
  type DocumentKindValue,
  type ExtractedField,
  type ReviewExtractionFormValues,
} from '@sales-tracker/core/schemas';
import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { Controller, useForm } from 'react-hook-form';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { applyResult } from '@/lib/apply-result';
import { CONFIDENCE_TEXT, fieldLabel } from '@/lib/document-labels';
import { formatDate } from '@/lib/format';
import { confirmExtractionAction } from '../../actions';

export interface ReviewFormRow {
  name: string;
  label: string;
  input: 'text' | 'date' | 'money' | 'textarea' | 'integer';
  /** Record field names this row writes, filled from `extracted` in the same order. */
  applies: string[];
  extracted: Record<string, ExtractedField | null>;
  current: Record<string, string | null>;
  lockedReason: string | null;
  suggested: boolean;
  /** A money row whose currency is the record's and cannot change (invoices, M10). */
  fixedCurrency: string | null;
}

type Change = { label: string; from: string; to: string };

/** The record field each extracted value fills, by position (amount→amount, …). */
function initialValues(rows: ReviewFormRow[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const row of rows) {
    const sources = Object.values(row.extracted);
    row.applies.forEach((field, index) => {
      values[field] = sources[index]?.value ?? row.current[field] ?? '';
    });
  }
  return values;
}

function display(row: ReviewFormRow, values: Record<string, string | null>): string {
  if (row.input === 'money') {
    const amount = values.amount ?? '';
    const currency = row.fixedCurrency ?? values.currency ?? '';
    if (!amount) return '—';
    if (!isIsoCurrency(currency)) return `${amount} ${currency}`.trim();
    const parsed = parseAmount(amount, currency);
    return parsed.ok ? formatMoney(parsed.value, currency) : `${amount} ${currency}`;
  }
  const value = values[row.applies[0]!] ?? '';
  if (!value) return '—';
  return row.input === 'date' ? formatDate(value) : value;
}

/** "Amount" → "amount", but "PO number" keeps its acronym, for "Apply …" labels. */
function sentenceTail(label: string): string {
  return label.replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase());
}

function confidenceOf(row: ReviewFormRow): ExtractedField['confidence'] | null {
  const fields = Object.values(row.extracted).filter((f): f is ExtractedField => !!f?.value);
  if (fields.length === 0) return null;
  if (fields.some((f) => f.confidence === 'low')) return 'low';
  return fields.some((f) => f.confidence === 'medium') ? 'medium' : 'high';
}

/**
 * The right half of the review screen: each value read from the document next to the
 * record's current one, editable, with an Apply box. Only ticked rows are sent, and only
 * after the user confirms the summary (CLAUDE.md rule 9).
 */
export function ReviewForm({
  kind,
  documentId,
  recordLabel,
  recordHref,
  rows,
  info,
  clientMismatch,
  warnings = [],
  currencies,
  editable,
  appliedFields,
}: {
  kind: DocumentKindValue;
  documentId: string;
  recordLabel: string;
  recordHref: string;
  rows: ReviewFormRow[];
  info: { name: string; label: string; extracted: ExtractedField | null }[];
  clientMismatch: string | null;
  /** Other mismatches between the document and the record (M10: PO number, currency). */
  warnings?: string[];
  currencies: string[];
  editable: boolean;
  /** Set once reviewed: which fields were applied. */
  appliedFields: string[] | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [summary, setSummary] = useState<{
    apply: Record<string, string>;
    changes: Change[];
  } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // The shared schema checks ticked values with the record's own form rules (CLAUDE.md).
  const schema = useMemo(() => reviewExtractionFormSchema(kind, rows), [kind, rows]);
  const form = useForm<ReviewExtractionFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      values: initialValues(rows),
      ticked: Object.fromEntries(rows.map((row) => [row.name, editable && row.suggested])),
    },
  });
  const ticked = form.watch('ticked');
  const values = form.watch('values');

  function prepare(withValues: boolean) {
    const apply: Record<string, string> = {};
    const changes: Change[] = [];
    if (withValues) {
      for (const row of rows) {
        if (!ticked[row.name] || row.lockedReason) continue;
        for (const field of row.applies) apply[field] = values[field] ?? '';
        changes.push({
          label: row.label,
          from: display(row, row.current),
          to: display(row, values),
        });
      }
    }
    setRowErrors({});
    setSummary({ apply, changes });
  }

  function submit() {
    if (!summary) return;
    startTransition(async () => {
      const result = await confirmExtractionAction({ documentId, apply: summary.apply });
      setSummary(null);
      if (applyResult(result, undefined, 'Document confirmed')) {
        router.push(recordHref);
        router.refresh();
        return;
      }
      if (!result.ok && result.fieldErrors) {
        // Server rules the form cannot check (e.g. a date before the enquiry arrived).
        const errors: Record<string, string> = {};
        for (const [field, messages] of Object.entries(result.fieldErrors)) {
          const row = rows.find((r) => r.name === field || r.applies.includes(field));
          if (row && messages[0]) errors[row.name] = messages[0];
        }
        setRowErrors(errors);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {clientMismatch && (
        <div
          role="alert"
          className="bg-warning-soft flex gap-2 rounded-[var(--radius-md)] border p-3 text-sm"
        >
          <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            The document is{' '}
            {kind === 'QUOTATION' ? 'addressed to' : kind === 'INVOICE' ? 'billed to' : 'from'}{' '}
            <strong>{clientMismatch}</strong>, which does not match the client on {recordLabel}.
            Check it is the right document before applying values.
          </p>
        </div>
      )}

      {warnings.map((warning) => (
        <div
          key={warning}
          role="alert"
          className="bg-warning-soft flex gap-2 rounded-[var(--radius-md)] border p-3 text-sm"
        >
          <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{warning}</p>
        </div>
      ))}

      {info.some((i) => i.extracted?.value) && (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {info.map((item) => (
            <div key={item.name} className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground text-[13px]">{item.label}</dt>
              <dd className="text-sm">{item.extracted?.value ?? '—'}</dd>
            </div>
          ))}
        </dl>
      )}

      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const confidence = confidenceOf(row);
          const low = confidence === 'low';
          const source = Object.values(row.extracted).find((f) => f?.sourceText);
          const disabled = !editable || !!row.lockedReason;
          const inputId = (field: string) => `review-${field}`;
          return (
            <li
              key={row.name}
              data-row={row.name}
              className={`flex flex-col gap-2 rounded-[var(--radius-md)] border p-3 ${low ? 'bg-warning-soft' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={!!ticked[row.name] && !row.lockedReason}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      form.setValue(`ticked.${row.name}`, checked === true, { shouldDirty: true })
                    }
                    aria-label={`Apply ${sentenceTail(row.label)}`}
                  />
                  {row.label}
                </label>
                {confidence && (
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    {low && <AlertTriangle className="text-warning size-3.5" aria-hidden />}
                    {CONFIDENCE_TEXT[confidence]}
                  </span>
                )}
              </div>

              {editable && !row.lockedReason ? (
                row.input === 'money' ? (
                  <div className="grid grid-cols-[1fr_7rem] gap-2">
                    <Input
                      id={inputId('amount')}
                      aria-label={`${row.label} from the document`}
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      {...form.register('values.amount')}
                    />
                    {row.fixedCurrency ? (
                      <span className="text-muted-foreground flex items-center text-sm">
                        {row.fixedCurrency}
                      </span>
                    ) : (
                      <Controller
                        control={form.control}
                        name="values.currency"
                        render={({ field }) => (
                          <Select value={field.value ?? ''} onValueChange={field.onChange}>
                            <SelectTrigger aria-label="Currency" className="w-full">
                              <SelectValue placeholder="Currency" />
                            </SelectTrigger>
                            <SelectContent>
                              {[...new Set([...currencies, field.value ?? ''])]
                                .filter(Boolean)
                                .map((code) => (
                                  <SelectItem key={code} value={code}>
                                    {code}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    )}
                  </div>
                ) : row.input === 'textarea' ? (
                  <Textarea
                    id={inputId(row.applies[0]!)}
                    aria-label={`${row.label} from the document`}
                    rows={3}
                    {...form.register(`values.${row.applies[0]!}`)}
                  />
                ) : (
                  <Input
                    id={inputId(row.applies[0]!)}
                    aria-label={`${row.label} from the document`}
                    type={row.input === 'date' ? 'date' : 'text'}
                    {...(row.input === 'integer' && {
                      inputMode: 'numeric' as const,
                      className: 'w-32 text-right tabular-nums',
                    })}
                    {...form.register(`values.${row.applies[0]!}`)}
                  />
                )
              ) : (
                <p className="text-sm">From the document: {display(row, initialValues([row]))}</p>
              )}

              <p className="text-muted-foreground text-[13px]">
                Now on {recordLabel}: {display(row, row.current)}
                {source?.sourceText && (
                  <>
                    {' · '}Read from “{source.sourceText}”
                    {source.page ? ` (page ${source.page})` : ''}
                  </>
                )}
              </p>
              {row.lockedReason && (
                <p className="text-muted-foreground text-[13px]">{row.lockedReason}</p>
              )}
              {[
                ...row.applies.map((field) => form.formState.errors.values?.[field]?.message),
                rowErrors[row.name],
              ]
                .filter(Boolean)
                .slice(0, 1)
                .map((message) => (
                  <p key={message} role="alert" className="text-destructive text-[13px]">
                    {message}
                  </p>
                ))}
            </li>
          );
        })}
      </ul>

      {appliedFields && (
        <p className="text-sm">
          {appliedFields.length > 0
            ? `Applied ${appliedFields.map(fieldLabel).join(', ')}.`
            : 'Confirmed without changes.'}
        </p>
      )}

      {editable && (
        <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
          <Button variant="outline" disabled={pending} onClick={() => prepare(false)}>
            Confirm without changes
          </Button>
          <Button
            disabled={pending || !rows.some((row) => ticked[row.name] && !row.lockedReason)}
            onClick={form.handleSubmit(() => prepare(true))}
          >
            Confirm and save
          </Button>
        </div>
      )}

      <AlertDialog open={summary !== null} onOpenChange={(open) => !open && setSummary(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {summary && summary.changes.length > 0
                ? `Update ${recordLabel}?`
                : `Confirm without changes?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                {summary && summary.changes.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {summary.changes.map((change) => (
                      <li key={change.label}>
                        <span className="font-medium">{change.label}:</span> {change.from} →{' '}
                        {change.to}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{recordLabel} stays as it is. The document is marked as confirmed.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              {summary && summary.changes.length > 0 ? 'Confirm and save' : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
