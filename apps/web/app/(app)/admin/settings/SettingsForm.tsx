'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { updateSettingsSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { applyResult } from '@/lib/apply-result';
import { updateSettingsAction } from './actions';

export function SettingsForm({
  values,
  baseCurrency,
}: {
  values: { companyName: string; defaultInvoiceDueDays: number; enabledCurrencies: string[] };
  baseCurrency: string;
}) {
  const router = useRouter();
  const form = useForm({ resolver: zodResolver(updateSettingsSchema), defaultValues: values });
  const { errors, isSubmitting } = form.formState;

  return (
    <form
      noValidate
      className="max-w-xl"
      onSubmit={form.handleSubmit(async (data) => {
        if (applyResult(await updateSettingsAction(data), form, 'Settings saved')) router.refresh();
      })}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(errors.companyName)}>
          <FieldLabel htmlFor="settings-company">Company name</FieldLabel>
          <Input id="settings-company" {...form.register('companyName')} />
          <FieldError errors={[errors.companyName]} />
        </Field>
        <Field data-invalid={Boolean(errors.defaultInvoiceDueDays)}>
          <FieldLabel htmlFor="settings-due-days">Default invoice due days</FieldLabel>
          <Input
            id="settings-due-days"
            type="number"
            min={0}
            max={365}
            {...form.register('defaultInvoiceDueDays')}
          />
          <FieldDescription>
            Invoice due date = invoice date + this many days (overridable per invoice).
          </FieldDescription>
          <FieldError errors={[errors.defaultInvoiceDueDays]} />
        </Field>
        <Field data-invalid={Boolean(errors.enabledCurrencies)}>
          <FieldLabel htmlFor="settings-currencies">Enabled currencies</FieldLabel>
          <Controller
            control={form.control}
            name="enabledCurrencies"
            render={({ field }) => (
              <Input
                id="settings-currencies"
                defaultValue={field.value.join(', ')}
                onChange={(event) =>
                  field.onChange(
                    event.target.value
                      .split(',')
                      .map((code) => code.trim().toUpperCase())
                      .filter(Boolean),
                  )
                }
              />
            )}
          />
          <FieldDescription>
            Comma-separated ISO codes, e.g. INR, USD, EUR. INR is required.
          </FieldDescription>
          <FieldError
            errors={
              Array.isArray(errors.enabledCurrencies)
                ? errors.enabledCurrencies.filter(Boolean)
                : [errors.enabledCurrencies]
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-base">Base currency</FieldLabel>
          <Input id="settings-base" value={baseCurrency} readOnly disabled />
          <FieldDescription>Fixed. Reports are in {baseCurrency}.</FieldDescription>
        </Field>
      </FieldGroup>
      <Button type="submit" className="mt-6" disabled={isSubmitting}>
        Save settings
      </Button>
    </form>
  );
}
