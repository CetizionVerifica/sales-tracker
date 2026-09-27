'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  createEnquirySchema,
  ENQUIRY_SOURCES,
  SOURCES_NEEDING_DETAIL,
  type CreateEnquiryInput,
  type EnquirySourceValue,
} from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { FormSheet } from '@/components/layout/FormSheet';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
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
import { applyResult } from '@/lib/apply-result';
import { SOURCE_DETAIL, SOURCE_LABELS } from '@/lib/enquiry-labels';
import { createEnquiryAction, updateEnquiryAction } from './actions';
import type { EnquiryFormOptions, Option } from './form-options';
import { NewClientDialog } from './NewClientDialog';

export interface EnquiryFormValues {
  id: string;
  number: string;
  clientId: string;
  sectorId: string;
  serviceIds: string[];
  receivedDate: string;
  proposalSentDate: string;
  source: EnquirySourceValue;
  sourceDetail: string;
  description: string;
  ownerId: string;
}

const label = (option: Option) => (option.note ? `${option.name} (${option.note})` : option.name);

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
 * New and edit share one form, validated with the shared createEnquirySchema. It submits
 * the raw values (`raw: true`): calendar dates stay `YYYY-MM-DD` strings on the wire and
 * are parsed once more by the action and service.
 */
export function EnquiryForm({
  enquiry,
  options,
  today,
  open,
  onOpenChange,
}: {
  enquiry?: EnquiryFormValues;
  options: EnquiryFormOptions;
  /** Today in IST (YYYY-MM-DD), the latest date the pickers allow. */
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [clients, setClients] = useState(options.clients);
  /** A client just created in the dialog, selected once its option has rendered. */
  const [createdClientId, setCreatedClientId] = useState<string | null>(null);
  const form = useForm<CreateEnquiryInput>({
    resolver: zodResolver(createEnquirySchema, undefined, { raw: true }),
    defaultValues: {
      clientId: enquiry?.clientId ?? '',
      sectorId: enquiry?.sectorId ?? '',
      serviceIds: enquiry?.serviceIds ?? [],
      receivedDate: enquiry?.receivedDate ?? today,
      proposalSentDate: enquiry?.proposalSentDate ?? '',
      source: enquiry?.source,
      sourceDetail: enquiry?.sourceDetail ?? '',
      description: enquiry?.description ?? '',
      ownerId: options.owners ? enquiry?.ownerId : undefined,
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;
  const source = useWatch({ control: form.control, name: 'source' });
  const detail = source ? SOURCE_DETAIL[source] : undefined;

  function pickClient(clientId: string) {
    form.setValue('clientId', clientId, { shouldValidate: form.formState.isSubmitted });
    // Default the sector to the client's (M4 Decision 3); still editable.
    const sectorId = clients.find((c) => c.id === clientId)?.sectorId;
    if (sectorId && options.sectors.some((s) => s.id === sectorId)) {
      form.setValue('sectorId', sectorId, { shouldValidate: form.formState.isSubmitted });
    }
  }

  // Radix Select mirrors its value into a hidden native <select>; a value whose <option>
  // is not rendered yet is reset to empty. So a new client is picked after the render
  // that adds it, not in the same update.
  useEffect(() => {
    if (!createdClientId || !clients.some((c) => c.id === createdClientId)) return;
    setCreatedClientId(null);
    pickClient(createdClientId);
  }, [clients, createdClientId]);

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
      title={enquiry ? `Edit ${enquiry.number}` : 'New enquiry'}
      description={enquiry ? undefined : 'Log it as soon as a client gets in touch.'}
      submitLabel={enquiry ? 'Save enquiry' : 'Create enquiry'}
      submitting={isSubmitting}
      dirty={isDirty}
      onSubmit={form.handleSubmit(async (data) => {
        const values = options.owners ? data : { ...data, ownerId: undefined };
        if (enquiry) {
          const result = await updateEnquiryAction({ id: enquiry.id, data: values });
          if (applyResult(result, form, 'Enquiry saved')) {
            form.reset(data);
            onOpenChange(false);
            router.refresh();
          }
          return;
        }
        const result = await createEnquiryAction(values);
        if (applyResult(result, form, 'Enquiry created')) {
          // Navigate only: closing the sheet here would also rewrite the URL (?new=1) and
          // race this push. Leaving the page closes the sheet.
          router.push(`/enquiries/${result.data.id}`);
        }
      })}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(errors.clientId)}>
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="enquiry-client">Client</FieldLabel>
            {options.canCreateClient && (
              <NewClientDialog
                sectors={options.sectors.filter((s) => !s.note)}
                onCreated={(client) => {
                  setClients((list) =>
                    [...list, client].sort((a, b) => a.name.localeCompare(b.name)),
                  );
                  setCreatedClientId(client.id);
                }}
              />
            )}
          </div>
          <Controller
            control={form.control}
            name="clientId"
            render={({ field }) => (
              <OptionSelect
                id="enquiry-client"
                value={field.value}
                onChange={pickClient}
                options={clients}
                placeholder="Choose a client"
              />
            )}
          />
          <FieldError errors={[errors.clientId]} />
        </Field>

        <Field data-invalid={Boolean(errors.sectorId)}>
          <FieldLabel htmlFor="enquiry-sector">Sector</FieldLabel>
          <Controller
            control={form.control}
            name="sectorId"
            render={({ field }) => (
              <OptionSelect
                id="enquiry-sector"
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
                {options.services.map((service) => {
                  const checked = field.value.includes(service.id);
                  return (
                    <label key={service.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={checked}
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
                  );
                })}
              </div>
            )}
          />
          <FieldError errors={[errors.serviceIds]} />
        </FieldSet>

        <div className="grid grid-cols-2 gap-4">
          <Field data-invalid={Boolean(errors.receivedDate)}>
            <FieldLabel htmlFor="enquiry-received">Received on</FieldLabel>
            <Input
              id="enquiry-received"
              type="date"
              max={today}
              {...form.register('receivedDate')}
            />
            <FieldError errors={[errors.receivedDate]} />
          </Field>
          <Field data-invalid={Boolean(errors.proposalSentDate)}>
            <FieldLabel htmlFor="enquiry-proposal">Proposal sent on (optional)</FieldLabel>
            <Input
              id="enquiry-proposal"
              type="date"
              max={today}
              {...form.register('proposalSentDate')}
            />
            <FieldError errors={[errors.proposalSentDate]} />
          </Field>
        </div>

        <Field data-invalid={Boolean(errors.source)}>
          <FieldLabel htmlFor="enquiry-source">Source</FieldLabel>
          <Controller
            control={form.control}
            name="source"
            render={({ field }) => (
              <Select value={field.value ?? ''} onValueChange={field.onChange}>
                <SelectTrigger id="enquiry-source" className="w-full">
                  <SelectValue placeholder="Where did it come from?" />
                </SelectTrigger>
                <SelectContent>
                  {ENQUIRY_SOURCES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {SOURCE_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldError errors={[errors.source]} />
        </Field>

        {detail && (
          <Field data-invalid={Boolean(errors.sourceDetail)}>
            <FieldLabel htmlFor="enquiry-source-detail">
              {detail.label}
              {source && SOURCES_NEEDING_DETAIL.has(source) ? '' : ' (optional)'}
            </FieldLabel>
            <Input
              id="enquiry-source-detail"
              placeholder={detail.placeholder}
              {...form.register('sourceDetail')}
            />
            <FieldError errors={[errors.sourceDetail]} />
          </Field>
        )}

        <Field data-invalid={Boolean(errors.description)}>
          <FieldLabel htmlFor="enquiry-description">What they asked for (optional)</FieldLabel>
          <Textarea id="enquiry-description" rows={3} {...form.register('description')} />
          <FieldError errors={[errors.description]} />
        </Field>

        {options.owners && (
          <Field data-invalid={Boolean(errors.ownerId)}>
            <FieldLabel htmlFor="enquiry-owner">Owner</FieldLabel>
            <Controller
              control={form.control}
              name="ownerId"
              render={({ field }) => (
                <OptionSelect
                  id="enquiry-owner"
                  value={field.value}
                  onChange={field.onChange}
                  options={options.owners ?? []}
                  placeholder="Me"
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
