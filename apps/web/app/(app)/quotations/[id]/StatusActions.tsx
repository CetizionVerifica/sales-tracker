'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { changeQuotationStatusSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { applyResult } from '@/lib/apply-result';
import { changeQuotationStatusAction } from '../actions';

type Target = 'SENT' | 'UNDER_NEGOTIATION' | 'PO_RECEIVED' | 'LOST';

interface StatusFormValues {
  id: string;
  to: Target;
  nextFollowUpDate?: string;
  poReceivedDate?: string;
  lostReason?: string;
}

const COPY: Record<Target, { label: string; title: string; description: string; success: string }> =
  {
    UNDER_NEGOTIATION: {
      label: 'Mark under negotiation',
      title: 'Under negotiation',
      description: 'The client is discussing terms. Confirm when to follow up next.',
      success: 'Quotation under negotiation',
    },
    SENT: {
      label: 'Back to sent',
      title: 'Back to sent',
      description: 'Negotiation has paused; the quotation waits for the client again.',
      success: 'Quotation back to sent',
    },
    PO_RECEIVED: {
      label: 'PO received',
      title: 'PO received',
      description: 'The client sent a purchase order. You can then create the project.',
      success: 'PO received',
    },
    LOST: {
      label: 'Mark lost',
      title: 'Mark as lost',
      description: 'Lost quotations cannot be reopened. Say why, for win/loss reports.',
      success: 'Quotation marked lost',
    },
  };

/**
 * One dialog per status move, asking only for what the move needs: the next follow-up date
 * (pre-filled), the PO received date, or the lost reason (M6 status machine).
 */
export function StatusDialog({
  id,
  to,
  nextFollowUpDate,
  quotationDate,
  today,
  variant = 'outline',
}: {
  id: string;
  to: Target;
  /** The stored next follow-up date (YYYY-MM-DD), pre-filled for SENT / UNDER_NEGOTIATION. */
  nextFollowUpDate: string;
  quotationDate: string;
  today: string;
  variant?: 'default' | 'outline';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const copy = COPY[to];
  const defaults: StatusFormValues =
    to === 'PO_RECEIVED'
      ? { id, to, poReceivedDate: today }
      : to === 'LOST'
        ? { id, to, lostReason: '' }
        : { id, to, nextFollowUpDate };
  const form = useForm<StatusFormValues>({
    resolver: zodResolver(changeQuotationStatusSchema, undefined, {
      raw: true,
    }) as unknown as Resolver<StatusFormValues>,
    defaultValues: defaults,
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={variant}>
          {copy.label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={form.handleSubmit(async (values) => {
            const result = await changeQuotationStatusAction(
              values as Parameters<typeof changeQuotationStatusAction>[0],
            );
            if (applyResult(result, form, copy.success)) {
              setOpen(false);
              router.refresh();
            }
          })}
        >
          {(to === 'SENT' || to === 'UNDER_NEGOTIATION') && (
            <Field data-invalid={Boolean(errors.nextFollowUpDate)}>
              <FieldLabel htmlFor="status-next">Next follow-up</FieldLabel>
              <Input
                id="status-next"
                type="date"
                min={quotationDate}
                {...form.register('nextFollowUpDate')}
              />
              <FieldError errors={[errors.nextFollowUpDate]} />
            </Field>
          )}
          {to === 'PO_RECEIVED' && (
            <Field data-invalid={Boolean(errors.poReceivedDate)}>
              <FieldLabel htmlFor="status-po-date">PO received on</FieldLabel>
              <Input
                id="status-po-date"
                type="date"
                min={quotationDate}
                max={today}
                {...form.register('poReceivedDate')}
              />
              <FieldError errors={[errors.poReceivedDate]} />
            </Field>
          )}
          {to === 'LOST' && (
            <Field data-invalid={Boolean(errors.lostReason)}>
              <FieldLabel htmlFor="status-lost-reason">Why was it lost?</FieldLabel>
              <Textarea id="status-lost-reason" rows={3} {...form.register('lostReason')} />
              <FieldError errors={[errors.lostReason]} />
            </Field>
          )}
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={isSubmitting}>
              {copy.label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
