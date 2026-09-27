'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { clientFormSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import { FormSheet } from '@/components/layout/FormSheet';
import { SheetLauncher } from '@/components/layout/SheetLauncher';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import { createClientAction, updateClientAction } from './actions';

export interface ClientFormValues {
  id?: string;
  name: string;
  sectorId: string;
  gstin: string;
  address: string;
  notes: string;
}

/** New and edit share one form (clientFormSchema); contacts live on the detail page. */
export function ClientForm({
  client,
  sectors,
  open,
  onOpenChange,
}: {
  client?: ClientFormValues;
  sectors: { id: string; name: string; note?: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(clientFormSchema),
    defaultValues: {
      name: client?.name ?? '',
      sectorId: client?.sectorId ?? '',
      gstin: client?.gstin ?? '',
      address: client?.address ?? '',
      notes: client?.notes ?? '',
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
      title={client?.id ? `Edit ${client.name}` : 'New client'}
      description={client?.id ? undefined : 'Contacts are added on the client record after saving.'}
      submitLabel={client?.id ? 'Save client' : 'Create client'}
      submitting={isSubmitting}
      dirty={isDirty}
      onSubmit={form.handleSubmit(async (data) => {
        if (client?.id) {
          if (
            applyResult(await updateClientAction({ id: client.id, data }), form, 'Client saved')
          ) {
            form.reset(data);
            onOpenChange(false);
            router.refresh();
          }
          return;
        }
        const result = await createClientAction({ ...data, contacts: [] });
        if (applyResult(result, form, 'Client created')) {
          // Navigate only (see EnquiryForm): leaving the page closes the sheet.
          router.push(`/admin/clients/${result.data.id}`);
        }
      })}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(errors.name)}>
          <FieldLabel htmlFor="client-name">Name</FieldLabel>
          <Input id="client-name" {...form.register('name')} />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={Boolean(errors.sectorId)}>
          <FieldLabel htmlFor="client-sector">Sector</FieldLabel>
          <Controller
            control={form.control}
            name="sectorId"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="client-sector" className="w-full">
                  <SelectValue placeholder="Choose a sector" />
                </SelectTrigger>
                <SelectContent>
                  {sectors.map((sector) => (
                    <SelectItem key={sector.id} value={sector.id}>
                      {sector.name}
                      {sector.note ? ` (${sector.note})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldError errors={[errors.sectorId]} />
        </Field>
        <Field data-invalid={Boolean(errors.gstin)}>
          <FieldLabel htmlFor="client-gstin">GSTIN (optional)</FieldLabel>
          <Input id="client-gstin" className="uppercase" {...form.register('gstin')} />
          <FieldError errors={[errors.gstin]} />
        </Field>
        <Field data-invalid={Boolean(errors.address)}>
          <FieldLabel htmlFor="client-address">Address (optional)</FieldLabel>
          <Textarea id="client-address" rows={2} {...form.register('address')} />
          <FieldError errors={[errors.address]} />
        </Field>
        <Field data-invalid={Boolean(errors.notes)}>
          <FieldLabel htmlFor="client-notes">Notes (optional)</FieldLabel>
          <Textarea id="client-notes" rows={3} {...form.register('notes')} />
          <FieldError errors={[errors.notes]} />
        </Field>
      </FieldGroup>
    </FormSheet>
  );
}

type SectorOption = { id: string; name: string; note?: string };

/** "New client" in the page header; also opens from `?new=1` (the + New menu). */
export function NewClientButton({ sectors }: { sectors: SectorOption[] }) {
  return (
    <SheetLauncher param="new" label="New client">
      {(open, onOpenChange) => (
        <ClientForm sectors={sectors} open={open} onOpenChange={onOpenChange} />
      )}
    </SheetLauncher>
  );
}

/** "Edit client" on the client record; also opens from `?edit=1`. */
export function EditClientButton({
  client,
  sectors,
}: {
  client: ClientFormValues;
  sectors: SectorOption[];
}) {
  return (
    <SheetLauncher param="edit" label="Edit client" variant="outline">
      {(open, onOpenChange) => (
        <ClientForm client={client} sectors={sectors} open={open} onOpenChange={onOpenChange} />
      )}
    </SheetLauncher>
  );
}
