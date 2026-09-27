'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { quickClientSchema, type QuickClientInput } from '@sales-tracker/core/schemas';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { applyResult } from '@/lib/apply-result';
import { createClientFromEnquiryAction } from './actions';

/** Creates a client (with an optional primary contact) without leaving the enquiry form. */
export function NewClientDialog({
  sectors,
  onCreated,
}: {
  sectors: { id: string; name: string }[];
  onCreated: (client: { id: string; name: string; sectorId: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const form = useForm<QuickClientInput>({
    resolver: zodResolver(quickClientSchema, undefined, { raw: true }),
    defaultValues: { name: '', sectorId: '', contactName: '', contactEmail: '', contactPhone: '' },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) form.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="link" size="sm" className="h-auto p-0">
          New client
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
        </DialogHeader>
        {/* A separate form element: this dialog renders in a portal, outside the enquiry form. */}
        <form
          noValidate
          onSubmit={(event) => {
            event.stopPropagation();
            void form.handleSubmit(async (data) => {
              const result = await createClientFromEnquiryAction(data);
              if (applyResult(result, form, 'Client created')) {
                onCreated(result.data);
                setOpen(false);
                form.reset();
              }
            })(event);
          }}
        >
          <FieldGroup>
            <Field data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor="new-client-name">Client name</FieldLabel>
              <Input id="new-client-name" {...form.register('name')} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={Boolean(errors.sectorId)}>
              <FieldLabel htmlFor="new-client-sector">Client sector</FieldLabel>
              <Controller
                control={form.control}
                name="sectorId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="new-client-sector" className="w-full">
                      <SelectValue placeholder="Choose a sector" />
                    </SelectTrigger>
                    <SelectContent>
                      {sectors.map((sector) => (
                        <SelectItem key={sector.id} value={sector.id}>
                          {sector.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError errors={[errors.sectorId]} />
            </Field>
            <Field data-invalid={Boolean(errors.contactName)}>
              <FieldLabel htmlFor="new-client-contact">Primary contact (optional)</FieldLabel>
              <Input id="new-client-contact" {...form.register('contactName')} />
              <FieldError errors={[errors.contactName]} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={Boolean(errors.contactEmail)}>
                <FieldLabel htmlFor="new-client-email">Contact email</FieldLabel>
                <Input id="new-client-email" type="email" {...form.register('contactEmail')} />
                <FieldError errors={[errors.contactEmail]} />
              </Field>
              <Field data-invalid={Boolean(errors.contactPhone)}>
                <FieldLabel htmlFor="new-client-phone">Contact phone</FieldLabel>
                <Input id="new-client-phone" type="tel" {...form.register('contactPhone')} />
                <FieldError errors={[errors.contactPhone]} />
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={isSubmitting}>
              Create client
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
