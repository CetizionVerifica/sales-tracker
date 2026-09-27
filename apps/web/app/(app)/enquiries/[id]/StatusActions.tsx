'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  convertEnquirySchema,
  markEnquiryLostSchema,
  type ConvertEnquiryInput,
  type MarkEnquiryLostInput,
} from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
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
import { Textarea } from '@/components/ui/textarea';
import { applyResult } from '@/lib/apply-result';
import { convertEnquiryAction, markEnquiryLostAction } from '../actions';

function ActionDialog({
  label,
  title,
  description,
  variant,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  title: string;
  description: string;
  variant: 'default' | 'outline';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant={variant}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Convert: asks for the proposal sent date (pre-filled when known). */
export function ConvertDialog({
  id,
  proposalSentDate,
  receivedDate,
  today,
}: {
  id: string;
  proposalSentDate: string;
  receivedDate: string;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm<ConvertEnquiryInput>({
    resolver: zodResolver(convertEnquirySchema, undefined, { raw: true }),
    defaultValues: { id, proposalSentDate: proposalSentDate || today },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <ActionDialog
      label="Convert"
      title="Convert to quotation"
      description="The enquiry is marked converted. You can then start a quotation pre-filled from it."
      variant="default"
      open={open}
      onOpenChange={setOpen}
    >
      <form
        noValidate
        onSubmit={form.handleSubmit(async (data) => {
          if (applyResult(await convertEnquiryAction(data), form, 'Enquiry converted')) {
            setOpen(false);
            router.refresh();
          }
        })}
      >
        <Field data-invalid={Boolean(errors.proposalSentDate)}>
          <FieldLabel htmlFor="convert-proposal">Proposal sent on</FieldLabel>
          <Input
            id="convert-proposal"
            type="date"
            min={receivedDate}
            max={today}
            {...form.register('proposalSentDate')}
          />
          <FieldError errors={[errors.proposalSentDate]} />
        </Field>
        <DialogFooter className="mt-6">
          <Button type="submit" disabled={isSubmitting}>
            Convert
          </Button>
        </DialogFooter>
      </form>
    </ActionDialog>
  );
}

/** Mark lost: a reason is required (M4 Decision 4). */
export function MarkLostDialog({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm<MarkEnquiryLostInput>({
    resolver: zodResolver(markEnquiryLostSchema, undefined, { raw: true }),
    defaultValues: { id, lostReason: '' },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <ActionDialog
      label="Mark lost"
      title="Mark as lost"
      description="Lost enquiries cannot be reopened."
      variant="outline"
      open={open}
      onOpenChange={setOpen}
    >
      <form
        noValidate
        onSubmit={form.handleSubmit(async (data) => {
          if (applyResult(await markEnquiryLostAction(data), form, 'Enquiry marked lost')) {
            setOpen(false);
            router.refresh();
          }
        })}
      >
        <Field data-invalid={Boolean(errors.lostReason)}>
          <FieldLabel htmlFor="lost-reason">Why was it lost?</FieldLabel>
          <Textarea id="lost-reason" rows={3} {...form.register('lostReason')} />
          <FieldError errors={[errors.lostReason]} />
        </Field>
        <DialogFooter className="mt-6">
          <Button type="submit" disabled={isSubmitting}>
            Mark lost
          </Button>
        </DialogFooter>
      </form>
    </ActionDialog>
  );
}
