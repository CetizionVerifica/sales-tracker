'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { contactSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Panel } from '@/components/charts/Panel';
import { RowActions } from '@/components/data/RowActions';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge } from '@/components/pipeline/StatusBadge';
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

function ContactDialog({
  clientId,
  contact,
  open: controlledOpen,
  onOpenChange,
}: {
  clientId: string;
  contact?: ContactView;
  /** Controlled from the contact's ⋯ menu: no trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (next: boolean) => (controlled ? onOpenChange?.(next) : setOwnOpen(next));
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
      {!controlled && (
        <DialogTrigger asChild>
          <Button size="sm" variant={contact ? 'outline' : 'default'}>
            {contact ? 'Edit' : 'Add contact'}
          </Button>
        </DialogTrigger>
      )}
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
              {contact ? 'Save contact' : 'Add contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One contact's ⋯ menu: edit, make primary, remove. */
function ContactActions({ clientId, contact }: { clientId: string; contact: ContactView }) {
  const [open, setOpen] = useState<'edit' | 'primary' | 'remove' | null>(null);
  const close = (next: boolean) => !next && setOpen(null);
  return (
    <div className="flex justify-end">
      <RowActions
        label={contact.name}
        actions={[
          { label: 'Edit contact', onSelect: () => setOpen('edit') },
          ...(contact.isPrimary
            ? []
            : [{ label: 'Make primary', onSelect: () => setOpen('primary') }]),
          { label: 'Remove', onSelect: () => setOpen('remove'), destructive: true },
        ]}
      />
      <ContactDialog
        clientId={clientId}
        contact={contact}
        open={open === 'edit'}
        onOpenChange={close}
      />
      <ConfirmDialog
        open={open === 'primary'}
        onOpenChange={close}
        label="Make primary"
        title={`Make ${contact.name} the primary contact?`}
        description="The current primary contact is unset."
        success="Primary contact updated"
        run={() => setPrimaryContactAction({ id: contact.id, clientId })}
      />
      <ConfirmDialog
        open={open === 'remove'}
        onOpenChange={close}
        variant="destructive"
        label="Remove"
        title={`Remove ${contact.name}?`}
        description="The contact is removed from this client (kept in the audit log)."
        success="Contact removed"
        run={() => removeContactAction({ id: contact.id, clientId })}
      />
    </div>
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
    <Panel title="Contacts" actions={<ContactDialog clientId={clientId} />} bodyClassName="p-0">
      {contacts.length === 0 ? (
        <EmptyState message="No contacts yet. Add who you speak to at this client." />
      ) : (
        <ul className="divide-y">
          {contacts.map((contact) => (
            <li key={contact.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 font-medium">
                  {contact.name}
                  {contact.isPrimary && <MarkBadge tone="primary">Primary</MarkBadge>}
                </span>
                <span className="text-muted-foreground truncate text-[13px]">
                  {[contact.designation, contact.email, contact.phone]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </span>
              </div>
              <ContactActions clientId={clientId} contact={contact} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
