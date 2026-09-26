'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { contactSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { applyResult } from '@/lib/apply-result';
import {
  addContactAction,
  removeContactAction,
  setPrimaryContactAction,
  updateContactAction,
} from '../actions';

export interface ContactView {
  id: string;
  name: string;
  designation: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}

function ContactDialog({ clientId, contact }: { clientId: string; contact?: ContactView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      name: contact?.name ?? '',
      designation: contact?.designation ?? '',
      email: contact?.email ?? '',
      phone: contact?.phone ?? '',
      isPrimary: contact?.isPrimary ?? false,
    },
  });
  const { errors, isSubmitting } = form.formState;
  const key = contact?.id ?? 'new';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={contact ? 'outline' : 'default'}>
          {contact ? 'Edit' : 'Add contact'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{contact ? `Edit ${contact.name}` : 'Add contact'}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          onSubmit={form.handleSubmit(async ({ isPrimary, ...fields }) => {
            const result = contact
              ? await updateContactAction({ id: contact.id, clientId, data: fields })
              : await addContactAction({ id: clientId, data: { ...fields, isPrimary } });
            if (applyResult(result, form, contact ? 'Contact saved' : 'Contact added')) {
              setOpen(false);
              if (!contact) form.reset();
              router.refresh();
            }
          })}
        >
          <FieldGroup>
            <Field data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor={`contact-name-${key}`}>Name</FieldLabel>
              <Input id={`contact-name-${key}`} {...form.register('name')} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={Boolean(errors.designation)}>
              <FieldLabel htmlFor={`contact-designation-${key}`}>Designation</FieldLabel>
              <Input id={`contact-designation-${key}`} {...form.register('designation')} />
              <FieldError errors={[errors.designation]} />
            </Field>
            <Field data-invalid={Boolean(errors.email)}>
              <FieldLabel htmlFor={`contact-email-${key}`}>Email</FieldLabel>
              <Input id={`contact-email-${key}`} type="email" {...form.register('email')} />
              <FieldError errors={[errors.email]} />
            </Field>
            <Field data-invalid={Boolean(errors.phone)}>
              <FieldLabel htmlFor={`contact-phone-${key}`}>Phone</FieldLabel>
              <Input id={`contact-phone-${key}`} type="tel" {...form.register('phone')} />
              <FieldError errors={[errors.phone]} />
            </Field>
            {!contact && (
              <Field orientation="horizontal">
                <Controller
                  control={form.control}
                  name="isPrimary"
                  render={({ field }) => (
                    <Checkbox
                      id={`contact-primary-${key}`}
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                  )}
                />
                <FieldLabel htmlFor={`contact-primary-${key}`}>Primary contact</FieldLabel>
              </Field>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={isSubmitting}>
              {contact ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Contacts of one client; each change is its own audited write (M2 rejects nested writes). */
export function ContactsSection({
  clientId,
  contacts,
}: {
  clientId: string;
  contacts: ContactView[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Contacts</h3>
        <ContactDialog clientId={clientId} />
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Designation</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contacts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground h-16 text-center">
                  No contacts yet.
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell>
                    {contact.name} {contact.isPrimary && <Badge variant="secondary">Primary</Badge>}
                  </TableCell>
                  <TableCell>{contact.designation || '—'}</TableCell>
                  <TableCell>{contact.email || '—'}</TableCell>
                  <TableCell>{contact.phone || '—'}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <ContactDialog clientId={clientId} contact={contact} />
                      {!contact.isPrimary && (
                        <ConfirmButton
                          label="Make primary"
                          title={`Make ${contact.name} the primary contact?`}
                          description="The current primary contact is unset."
                          success="Primary contact updated"
                          run={() => setPrimaryContactAction({ id: contact.id, clientId })}
                        />
                      )}
                      <ConfirmButton
                        label="Remove"
                        variant="destructive"
                        title={`Remove ${contact.name}?`}
                        description="The contact is removed from this client (kept in the audit log)."
                        success="Contact removed"
                        run={() => removeContactAction({ id: contact.id, clientId })}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
