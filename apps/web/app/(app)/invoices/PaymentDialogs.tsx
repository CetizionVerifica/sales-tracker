'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { markInvoicePaidSchema, markInvoiceUnpaidSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState, type ComponentProps } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { applyResult } from '@/lib/apply-result';
import { markInvoicePaidAction, markInvoiceUnpaidAction } from './actions';

interface PaidValues {
  id: string;
  paidAt: string;
  paymentReference: string;
}

/**
 * Mark paid (M10 Decision 14): the day the payment arrived (today by default) and an
 * optional reference. Paid in full; a short payment for TDS is noted in the reference
 * (Decision 13).
 */
export function MarkPaidDialog({
  id,
  label,
  invoiceDate,
  today,
  size = 'sm',
  variant = 'default',
}: {
  id: string;
  /** "Invoice INV/26-27/0042", for the title. */
  label: string;
  /** YYYY-MM-DD: the earliest paid date. */
  invoiceDate: string;
  today: string;
  size?: ComponentProps<typeof Button>['size'];
  variant?: ComponentProps<typeof Button>['variant'];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const defaults: PaidValues = { id, paidAt: today, paymentReference: '' };
  const form = useForm<PaidValues>({
    resolver: zodResolver(markInvoicePaidSchema, undefined, {
      raw: true,
    }) as unknown as Resolver<PaidValues>,
    defaultValues: defaults,
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset(defaults);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size={size} variant={variant}>
          Mark paid
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark {label} paid</DialogTitle>
          <DialogDescription>
            Record when the payment arrived. The invoice counts as paid in full.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(async (values) => {
            const result = await markInvoicePaidAction(values);
            if (applyResult(result, form, 'Invoice marked paid')) {
              setOpen(false);
              router.refresh();
            }
          })}
        >
          <Field data-invalid={Boolean(errors.paidAt)}>
            <FieldLabel htmlFor={`paid-at-${id}`}>Paid on</FieldLabel>
            <Input
              id={`paid-at-${id}`}
              type="date"
              min={invoiceDate}
              max={today}
              {...form.register('paidAt')}
            />
            <FieldError errors={[errors.paidAt]} />
          </Field>
          <Field data-invalid={Boolean(errors.paymentReference)}>
            <FieldLabel htmlFor={`paid-ref-${id}`}>Payment reference (optional)</FieldLabel>
            <Input
              id={`paid-ref-${id}`}
              autoComplete="off"
              {...form.register('paymentReference')}
            />
            <FieldDescription>UTR, cheque number, or a note such as TDS deducted.</FieldDescription>
            <FieldError errors={[errors.paymentReference]} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              Mark paid
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface UnpaidValues {
  id: string;
  reason: string;
}

/**
 * Mark unpaid (admins, M10 Decision 8): reverses a payment recorded by mistake or bounced.
 * The reason is kept on the invoice and in its audit row.
 */
export function MarkUnpaidDialog({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const defaults: UnpaidValues = { id, reason: '' };
  const form = useForm<UnpaidValues>({
    resolver: zodResolver(markInvoiceUnpaidSchema, undefined, {
      raw: true,
    }) as unknown as Resolver<UnpaidValues>,
    defaultValues: defaults,
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset(defaults);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Mark unpaid
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark {label} unpaid?</DialogTitle>
          <DialogDescription>
            The paid date and reference are cleared, and the invoice is pending or overdue again by
            its due date.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(async (values) => {
            const result = await markInvoiceUnpaidAction(values);
            if (applyResult(result, form, 'Invoice marked unpaid')) {
              setOpen(false);
              router.refresh();
            }
          })}
        >
          <Field data-invalid={Boolean(errors.reason)}>
            <FieldLabel htmlFor={`unpaid-reason-${id}`}>Reason</FieldLabel>
            <Textarea id={`unpaid-reason-${id}`} rows={3} {...form.register('reason')} />
            <FieldError errors={[errors.reason]} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              Mark unpaid
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
