'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  createFollowUpSchema,
  FOLLOW_UP_CHANNELS,
  updateFollowUpSchema,
  type FollowUpChannelValue,
  type FollowUpEntityTypeValue,
} from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
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
import { CHANNEL_LABELS, ENTITY_TYPE_LABELS } from '@/lib/follow-up-labels';
import { logFollowUpAction, updateFollowUpAction } from './actions';

export interface FollowUpTargetOption {
  entityType: FollowUpEntityTypeValue;
  entityId: string;
  label: string;
}

export interface FollowUpFormValues {
  entityType: FollowUpEntityTypeValue;
  entityId: string;
  date: string;
  channel: FollowUpChannelValue | '';
  contactId: string;
  notes: string;
  nextFollowUpDate: string;
}

/** Radix Select cannot hold an empty value, so "no contact" is a sentinel. */
const NO_CONTACT = '__none__';
const QUICK_PICKS = [
  { label: '+3 days', days: 3 },
  { label: '+1 week', days: 7 },
  { label: '+2 weeks', days: 14 },
];

const targetKey = (t: { entityType: string; entityId: string }) => `${t.entityType}:${t.entityId}`;

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Log a follow-up (create) or correct one (edit). On create, `targets` are the records the
 * user may attach it to; a single target is fixed (opened from a record page).
 */
export function FollowUpDialog({
  mode,
  targets = [],
  contacts,
  today,
  initial,
  triggerLabel,
  triggerVariant = 'default',
  nextRequired = false,
}: {
  mode: 'create' | 'edit';
  targets?: FollowUpTargetOption[];
  contacts: { id: string; name: string }[];
  today: string;
  /** Edit: the follow-up's id and current values. */
  initial?: { id: string } & FollowUpFormValues;
  triggerLabel: string;
  triggerVariant?: 'default' | 'outline' | 'ghost';
  /** An open quotation needs a next date on every follow-up (M6); the server enforces it. */
  nextRequired?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const first = targets[0];
  const defaults: FollowUpFormValues = initial ?? {
    entityType: first?.entityType ?? 'CLIENT',
    entityId: first?.entityId ?? '',
    date: today,
    channel: '',
    contactId: '',
    notes: '',
    nextFollowUpDate: '',
  };
  const schema = mode === 'create' ? createFollowUpSchema : updateFollowUpSchema;
  const form = useForm<FollowUpFormValues>({
    // Raw values: dates stay YYYY-MM-DD on the wire (M4 implementation note). The form holds
    // strings the schema validates; with raw: true its parsed output type is not used, so
    // the resolver is typed to the form values.
    resolver: zodResolver(schema, undefined, {
      raw: true,
    }) as unknown as Resolver<FollowUpFormValues>,
    defaultValues: defaults,
  });
  const { errors, isSubmitting } = form.formState;
  const date = form.watch('date');

  async function submit(values: FollowUpFormValues) {
    const { entityType, entityId, ...fields } = values;
    // Validation has passed, so channel is one of the enum values.
    const data = { ...fields, channel: fields.channel as FollowUpChannelValue };
    const result =
      mode === 'create'
        ? await logFollowUpAction({ entityType, entityId, ...data })
        : await updateFollowUpAction({ id: initial!.id, data });
    if (applyResult(result, form, mode === 'create' ? 'Follow-up logged' : 'Follow-up updated')) {
      setOpen(false);
      form.reset(mode === 'create' ? defaults : values);
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={triggerVariant}>
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Log follow-up' : 'Edit follow-up'}</DialogTitle>
          <DialogDescription>
            Record a touchpoint that happened, and when to follow up next.
          </DialogDescription>
        </DialogHeader>
        <form noValidate className="flex flex-col gap-4" onSubmit={form.handleSubmit(submit)}>
          {mode === 'create' && targets.length > 1 && (
            <Field data-invalid={Boolean(errors.entityId)}>
              <FieldLabel htmlFor="follow-up-record">About</FieldLabel>
              <Select
                value={targetKey(form.watch())}
                onValueChange={(key) => {
                  const target = targets.find((t) => targetKey(t) === key);
                  if (!target) return;
                  form.setValue('entityType', target.entityType);
                  form.setValue('entityId', target.entityId);
                }}
              >
                <SelectTrigger id="follow-up-record" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={targetKey(t)} value={targetKey(t)}>
                      {t.entityType === 'CLIENT'
                        ? `${t.label} (client)`
                        : `${ENTITY_TYPE_LABELS[t.entityType]} ${t.label}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={[errors.entityId]} />
            </Field>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field data-invalid={Boolean(errors.date)}>
              <FieldLabel htmlFor="follow-up-date">Date</FieldLabel>
              <Input id="follow-up-date" type="date" max={today} {...form.register('date')} />
              <FieldError errors={[errors.date]} />
            </Field>
            <Field data-invalid={Boolean(errors.channel)}>
              <FieldLabel htmlFor="follow-up-channel">Channel</FieldLabel>
              <Controller
                control={form.control}
                name="channel"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="follow-up-channel" className="w-full">
                      <SelectValue placeholder="How were you in touch?" />
                    </SelectTrigger>
                    <SelectContent>
                      {FOLLOW_UP_CHANNELS.map((channel) => (
                        <SelectItem key={channel} value={channel}>
                          {CHANNEL_LABELS[channel]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError errors={[errors.channel]} />
            </Field>
          </div>

          <Field data-invalid={Boolean(errors.contactId)}>
            <FieldLabel htmlFor="follow-up-contact">Contact</FieldLabel>
            <Controller
              control={form.control}
              name="contactId"
              render={({ field }) => (
                <Select
                  value={field.value || NO_CONTACT}
                  onValueChange={(value) => field.onChange(value === NO_CONTACT ? '' : value)}
                >
                  <SelectTrigger id="follow-up-contact" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CONTACT}>No contact</SelectItem>
                    {contacts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <FieldError errors={[errors.contactId]} />
          </Field>

          <Field data-invalid={Boolean(errors.notes)}>
            <FieldLabel htmlFor="follow-up-notes">Notes</FieldLabel>
            <Textarea id="follow-up-notes" rows={4} {...form.register('notes')} />
            <FieldError errors={[errors.notes]} />
          </Field>

          <Field data-invalid={Boolean(errors.nextFollowUpDate)}>
            <FieldLabel htmlFor="follow-up-next">
              Next follow-up{nextRequired ? '' : ' (optional)'}
            </FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="follow-up-next"
                type="date"
                min={date || undefined}
                className="w-44"
                {...form.register('nextFollowUpDate')}
              />
              {QUICK_PICKS.map(({ label, days }) => (
                <Button
                  key={label}
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    form.setValue('nextFollowUpDate', addDays(date || today, days), {
                      shouldValidate: true,
                    })
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
            <FieldError errors={[errors.nextFollowUpDate]} />
          </Field>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {mode === 'create' ? 'Log follow-up' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
