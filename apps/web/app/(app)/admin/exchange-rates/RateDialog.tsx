'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { exchangeRateEditSchema, exchangeRateFormSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { applyResult } from '@/lib/apply-result';
import { createExchangeRateAction, updateExchangeRateAction } from './actions';

export interface RateRowView {
  id: string;
  currency: string;
  month: string;
  rate: string;
  recordCount: number;
  staleCount: number;
}

interface Values {
  currency: string;
  month: string;
  rate: string;
}

/** New rate (currency, month, rate) or edit one's rate. */
export function RateDialog({
  currencies,
  thisMonth,
  row,
  open: controlledOpen,
  onOpenChange,
}: {
  /** Enabled currencies other than INR. */
  currencies: string[];
  /** `YYYY-MM`, the default month. */
  thisMonth: string;
  row?: RateRowView;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (next: boolean) => (controlled ? onOpenChange?.(next) : setOwnOpen(next));
  // Editing sends the rate alone: the edit schema is strict, and extra keys would fail
  // validation with no field to show the error on.
  const defaults = (
    row ? { rate: row.rate } : { currency: currencies[0] ?? '', month: thisMonth, rate: '' }
  ) as Values;
  const form = useForm<Values>({
    resolver: zodResolver(
      row ? exchangeRateEditSchema : exchangeRateFormSchema,
    ) as unknown as Resolver<Values>,
    defaultValues: defaults,
  });
  const { errors, isSubmitting } = form.formState;
  const id = row?.id ?? 'new';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset(defaults);
        setOpen(next);
      }}
    >
      {!controlled && (
        <DialogTrigger asChild>
          <Button disabled={currencies.length === 0}>New rate</Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {row ? `Edit ${row.currency} rate for ${row.month}` : 'New exchange rate'}
          </DialogTitle>
          <DialogDescription>
            {row
              ? 'Records already converted keep their rate until you recalculate the month.'
              : 'INR per one unit, used for every record dated in that month.'}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={form.handleSubmit(async (values) => {
            if (row) {
              const result = await updateExchangeRateAction({
                id: row.id,
                data: { rate: values.rate },
              });
              if (applyResult(result, form, 'Rate saved')) {
                if (result.ok && result.data.stale > 0) {
                  toast.message(
                    `${result.data.stale} ${result.data.stale === 1 ? 'record still uses' : 'records still use'} the old rate. Recalculate the month to update them.`,
                  );
                }
                setOpen(false);
                router.refresh();
              }
            } else {
              const result = await createExchangeRateAction(values);
              if (applyResult(result, form, 'Rate created')) {
                if (result.ok && result.data.filled > 0) {
                  toast.message(
                    `${result.data.filled} ${result.data.filled === 1 ? 'record now has' : 'records now have'} an INR value.`,
                  );
                }
                setOpen(false);
                form.reset(defaults);
                router.refresh();
              }
            }
          })}
        >
          <FieldGroup>
            {!row && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field data-invalid={Boolean(errors.currency)}>
                  <FieldLabel htmlFor={`rate-currency-${id}`}>Currency</FieldLabel>
                  <Controller
                    control={form.control}
                    name="currency"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id={`rate-currency-${id}`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {currencies.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <FieldError errors={[errors.currency]} />
                </Field>
                <Field data-invalid={Boolean(errors.month)}>
                  <FieldLabel htmlFor={`rate-month-${id}`}>Month</FieldLabel>
                  <Input id={`rate-month-${id}`} type="month" {...form.register('month')} />
                  <FieldError errors={[errors.month]} />
                </Field>
              </div>
            )}
            <Field data-invalid={Boolean(errors.rate)}>
              <FieldLabel htmlFor={`rate-value-${id}`}>INR per unit</FieldLabel>
              <Input
                id={`rate-value-${id}`}
                inputMode="decimal"
                autoComplete="off"
                {...form.register('rate')}
              />
              <FieldDescription>Up to six decimals, e.g. 83.125</FieldDescription>
              <FieldError errors={[errors.rate]} />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {row ? 'Save rate' : 'Create rate'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
