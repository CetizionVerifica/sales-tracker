'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  closedQuotationFormSchema,
  createQuotationFormSchema,
  formatMoney,
  isIsoCurrency,
  parseAmount,
} from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FormSheet } from '@/components/layout/FormSheet';
import { applyResult } from '@/lib/apply-result';
import type { Option } from '../enquiries/form-options';
import { createQuotationAction, updateQuotationAction } from './actions';
import type { QuotationFormOptions } from './form-options';

/** Everything as the inputs hold it: strings, dates as YYYY-MM-DD. */
export interface QuotationFormValues {
  enquiryId: string;
  quotationDate: string;
  amount: string;
  currency: string;
  sectorId: string;
  serviceIds: string[];
  nextFollowUpDate: string;
  description: string;
  lastFollowUpHighlights: string;
  /** Admins only; unset means the enquiry's owner (create) or unchanged (edit). */
  ownerId?: string;
}

const QUICK_PICKS = [
  { label: '+3 days', days: 3 },
  { label: '+1 week', days: 7 },
  { label: '+2 weeks', days: 14 },
];

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const label = (option: Option) => (option.note ? `${option.name} (${option.note})` : option.name);

/** The amount as it will be saved, or null while it doesn't parse yet. */
function preview(amount: string, currency: string): string | null {
  if (!amount || !isIsoCurrency(currency)) return null;
  const parsed = parseAmount(amount, currency);
  return parsed.ok ? formatMoney(parsed.value, currency) : null;
}

function OptionSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
}: {
  id: string;
  value: string | undefined;
  onChange: (value: string) => void;
  options: Option[];
  placeholder: string;
}) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {label(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * New and edit share one form. An open quotation is validated with the shared create schema
 * (the enquiry id rides along and is dropped on update); a closed one (PO received or lost)
 * only edits its description and highlights, and its owner for admins (M6 Decisions 9 and
 * 11, M8 Decision 4). Raw values are
 * submitted: dates stay YYYY-MM-DD and the amount stays as typed until the service
 * converts it to minor units.
 */
export function QuotationForm({
  quotation,
  initial,
  client,
  options,
  today,
  closed = false,
  enquiryNumber,
  open,
  onOpenChange,
}: {
  /** Edit: the quotation's id and number. */
  quotation?: { id: string; number: string };
  initial: QuotationFormValues;
  client: string;
  options: QuotationFormOptions;
  /** Today in IST (YYYY-MM-DD), the latest date the pickers allow. */
  today: string;
  closed?: boolean;
  /** Create: the enquiry it comes from ("From ENQ-0142", UI guide §4.3). */
  enquiryNumber?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const schema = closed ? closedQuotationFormSchema : createQuotationFormSchema;
  const form = useForm<QuotationFormValues>({
    // With raw: true the parsed output type is unused, so the resolver is typed to the
    // form values (as in the follow-up dialog).
    resolver: zodResolver(schema, undefined, {
      raw: true,
    }) as unknown as Resolver<QuotationFormValues>,
    defaultValues: {
      ...initial,
      ownerId: options.owners ? initial.ownerId : undefined,
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;
  const [amount, currency, quotationDate] = useWatch({
    control: form.control,
    name: ['amount', 'currency', 'quotationDate'],
  });
  const formatted = preview(amount, currency);

  async function submit(values: QuotationFormValues) {
    const { enquiryId, ownerId, ...fields } = values;
    const owner = options.owners && ownerId ? { ownerId } : {};
    if (!quotation) {
      const result = await createQuotationAction({ enquiryId, ...fields, ...owner });
      if (applyResult(result, form, 'Quotation created')) {
        // Navigate only (see EnquiryForm): leaving the page closes the sheet.
        router.push(`/quotations/${result.data.id}`);
      }
      return;
    }
    const data = closed
      ? {
          description: fields.description,
          lastFollowUpHighlights: fields.lastFollowUpHighlights,
          ...owner,
        }
      : { ...fields, ...owner };
    const result = await updateQuotationAction({ id: quotation.id, data });
    if (applyResult(result, form, 'Quotation saved')) {
      form.reset(values);
      onOpenChange(false);
      router.refresh();
    }
  }

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
      title={quotation ? `Edit ${quotation.number}` : 'New quotation'}
      description={
        quotation
          ? closed
            ? 'A quotation with a PO received or marked lost only takes notes and, for admins, a new owner.'
            : undefined
          : enquiryNumber
            ? `From ${enquiryNumber}. Client, sector and services come from the enquiry.`
            : undefined
      }
      submitLabel={quotation ? 'Save quotation' : 'Create quotation'}
      submitting={isSubmitting}
      dirty={isDirty}
      onSubmit={form.handleSubmit(submit)}
    >
      <FieldGroup>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field>
            <span className="text-muted-foreground text-[13px]">Client</span>
            <span data-testid="quotation-client">{client}</span>
            <FieldDescription>Always the enquiry’s client.</FieldDescription>
          </Field>
        </div>

        {!closed && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
              <Field data-invalid={Boolean(errors.amount)}>
                <FieldLabel htmlFor="quotation-amount">Amount</FieldLabel>
                <Input
                  id="quotation-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="e.g. 1,25,000.50"
                  {...form.register('amount')}
                />
                {formatted && <FieldDescription>{formatted}</FieldDescription>}
                <FieldError errors={[errors.amount]} />
              </Field>
              <Field data-invalid={Boolean(errors.currency)}>
                <FieldLabel htmlFor="quotation-currency">Currency</FieldLabel>
                <Controller
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="quotation-currency" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {options.currencies.map((code) => (
                          <SelectItem key={code} value={code}>
                            {code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.currency]} />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.quotationDate)}>
                <FieldLabel htmlFor="quotation-date">Quotation date</FieldLabel>
                <Input
                  id="quotation-date"
                  type="date"
                  max={today}
                  {...form.register('quotationDate')}
                />
                <FieldError errors={[errors.quotationDate]} />
              </Field>
              <Field data-invalid={Boolean(errors.nextFollowUpDate)}>
                <FieldLabel htmlFor="quotation-next">Next follow-up</FieldLabel>
                <Input
                  id="quotation-next"
                  type="date"
                  min={quotationDate || undefined}
                  {...form.register('nextFollowUpDate')}
                />
                <div className="flex flex-wrap gap-1">
                  {QUICK_PICKS.map(({ label: pick, days }) => (
                    <Button
                      key={pick}
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        form.setValue('nextFollowUpDate', addDays(today, days), {
                          shouldValidate: form.formState.isSubmitted,
                        })
                      }
                    >
                      {pick}
                    </Button>
                  ))}
                </div>
                <FieldError errors={[errors.nextFollowUpDate]} />
              </Field>
            </div>

            <Field data-invalid={Boolean(errors.sectorId)}>
              <FieldLabel htmlFor="quotation-sector">Sector</FieldLabel>
              <Controller
                control={form.control}
                name="sectorId"
                render={({ field }) => (
                  <OptionSelect
                    id="quotation-sector"
                    value={field.value}
                    onChange={field.onChange}
                    options={options.sectors}
                    placeholder="Choose a sector"
                  />
                )}
              />
              <FieldError errors={[errors.sectorId]} />
            </Field>

            <FieldSet data-invalid={Boolean(errors.serviceIds)}>
              <FieldLegend variant="label">Services</FieldLegend>
              <Controller
                control={form.control}
                name="serviceIds"
                render={({ field }) => (
                  <div className="grid grid-cols-2 gap-2">
                    {options.services.map((service) => (
                      <label key={service.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={field.value.includes(service.id)}
                          onCheckedChange={(next) =>
                            field.onChange(
                              next === true
                                ? [...field.value, service.id]
                                : field.value.filter((id) => id !== service.id),
                            )
                          }
                        />
                        {label(service)}
                      </label>
                    ))}
                  </div>
                )}
              />
              <FieldError errors={[errors.serviceIds]} />
            </FieldSet>
          </>
        )}

        <Field data-invalid={Boolean(errors.description)}>
          <FieldLabel htmlFor="quotation-description">Scope and notes (optional)</FieldLabel>
          <Textarea id="quotation-description" rows={3} {...form.register('description')} />
          <FieldError errors={[errors.description]} />
        </Field>

        <Field data-invalid={Boolean(errors.lastFollowUpHighlights)}>
          <FieldLabel htmlFor="quotation-highlights">Follow-up highlights (optional)</FieldLabel>
          <Textarea
            id="quotation-highlights"
            rows={2}
            {...form.register('lastFollowUpHighlights')}
          />
          <FieldDescription>Replaced by the notes of the next follow-up you log.</FieldDescription>
          <FieldError errors={[errors.lastFollowUpHighlights]} />
        </Field>

        {options.owners && (
          <Field data-invalid={Boolean(errors.ownerId)}>
            <FieldLabel htmlFor="quotation-owner">Owner</FieldLabel>
            <Controller
              control={form.control}
              name="ownerId"
              render={({ field }) => (
                <OptionSelect
                  id="quotation-owner"
                  value={field.value}
                  onChange={field.onChange}
                  options={options.owners ?? []}
                  placeholder="The enquiry’s owner"
                />
              )}
            />
            <FieldError errors={[errors.ownerId]} />
          </Field>
        )}
      </FieldGroup>
    </FormSheet>
  );
}
