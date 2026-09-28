'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  createInvoiceFormSchema,
  dueDateHint,
  formatMoney,
  parseAmount,
  toCalendarDateString,
  updateInvoiceFormSchema,
  type DueDateBasisValue,
} from '@sales-tracker/core/schemas';
import { defaultDueDate } from '@sales-tracker/core/status';
import { AlertTriangle, FileText, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import { ACCEPTED_TYPES, formatBytes } from '@/lib/document-labels';
import { uploadDocumentFile } from '@/lib/document-upload';
import { createInvoiceAction, updateInvoiceAction } from './actions';

/** Everything as the inputs hold it: strings, dates as YYYY-MM-DD. */
export interface InvoiceFormValues {
  purchaseOrderId: string;
  invoiceNumber: string;
  invoiceDate: string;
  serviceId: string;
  amount: string;
  dueDate: string;
  /** Create only: record an invoice that is already paid (back-entry). Not sent. */
  alreadyPaid: boolean;
  paidAt: string;
  paymentReference: string;
  description: string;
}

type EditableField = 'invoiceNumber' | 'invoiceDate' | 'serviceId' | 'amount' | 'description';
const EDITABLE: readonly EditableField[] = [
  'invoiceNumber',
  'invoiceDate',
  'serviceId',
  'amount',
  'description',
];

/** What the form knows about the PO the invoice is on. */
export interface InvoiceFormPo {
  poNumber: string;
  client: string;
  project: string;
  services: { id: string; name: string }[];
  currency: string;
  /** Minor units as strings: no BigInt reaches the browser. */
  amountMinor: string;
  /** Live invoices on the PO, other than this one. */
  otherInvoicesMinor: string;
  /** The PO's net days, or null (then the company default applies). */
  paymentTermsDays: number | null;
  companyDefaultDays: number;
}

const TYPES = new Set(ACCEPTED_TYPES.split(','));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The due date the server would give this invoice date, or null while the date is unset. */
function defaultDue(invoiceDate: string, po: InvoiceFormPo): string | null {
  if (!DAY.test(invoiceDate)) return null;
  return toCalendarDateString(
    defaultDueDate({
      invoiceDate: new Date(`${invoiceDate}T00:00:00.000Z`),
      poPaymentTermsDays: po.paymentTermsDays,
      companyDefaultDays: po.companyDefaultDays,
    }).dueDate,
  );
}

/** The amount in the PO's currency, or null while it doesn't parse yet. */
function parsed(amount: string, currency: string): bigint | null {
  if (!amount) return null;
  const result = parseAmount(amount, currency);
  return result.ok ? result.value : null;
}

/**
 * Create and edit share one full-page form (UI guide §4.3: invoices are a larger form).
 * Create starts from getInvoiceDraft; the due date follows the invoice date from the PO's
 * terms or the company default until it is typed (M10 Decision 6), and after saving the
 * file goes to the M7 upload route (M9 Decision 3's flow). Edit sends only changed fields.
 */
export function InvoiceForm({
  invoice,
  initial,
  initialBasis,
  po,
  hints,
  maxMb,
  cancelHref,
}: {
  /** Edit: the invoice's id and number. */
  invoice?: { id: string; invoiceNumber: string };
  initial: InvoiceFormValues;
  initialBasis: DueDateBasisValue;
  po: InvoiceFormPo;
  /** Create: where the pre-filled amount came from. */
  hints?: { amount: string | null };
  /** Create: the largest document accepted. */
  maxMb?: number;
  cancelHref: string;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // A MANUAL due date stays put; otherwise it follows the invoice date (Decision 6).
  const [manualDue, setManualDueState] = useState(initialBasis === 'MANUAL');
  const [dueReset, setDueReset] = useState(false);
  // The resolver may be kept from the first render, so it reads this ref, not the state.
  const manualRef = useRef(manualDue);
  const setManualDue = (next: boolean) => {
    manualRef.current = next;
    setManualDueState(next);
  };

  /** What is sent: the checkbox and an untouched default due date are not. */
  function payload(values: InvoiceFormValues) {
    const { alreadyPaid, paidAt, paymentReference, dueDate, ...rest } = values;
    return {
      ...rest,
      ...(manualRef.current && { dueDate }),
      ...(alreadyPaid && { paidAt, paymentReference }),
    };
  }

  // With raw: true the parsed output type is unused, so the resolver is typed to the form
  // values; it validates what will be sent, as in the PO form.
  const createResolver = zodResolver(createInvoiceFormSchema, undefined, {
    raw: true,
  }) as unknown as Resolver<InvoiceFormValues>;
  const updateResolver = zodResolver(updateInvoiceFormSchema, undefined, {
    raw: true,
  }) as unknown as Resolver<InvoiceFormValues>;
  const resolver: Resolver<InvoiceFormValues> = (values, context, options) => {
    if (!invoice) return createResolver(payload(values) as InvoiceFormValues, context, options);
    const { purchaseOrderId: _po, ...fields } = payload(values);
    return updateResolver(fields as InvoiceFormValues, context, options);
  };
  const form = useForm<InvoiceFormValues>({ resolver, defaultValues: initial });
  const { errors, isSubmitting, dirtyFields } = form.formState;
  const [amount, invoiceDate, alreadyPaid] = useWatch({
    control: form.control,
    name: ['amount', 'invoiceDate', 'alreadyPaid'],
  });

  const value = parsed(amount, po.currency);
  const total = value === null ? null : BigInt(po.otherInvoicesMinor) + value;
  const poAmount = BigInt(po.amountMinor);
  const over = total !== null && total > poAmount;
  const hint = manualDue
    ? 'Custom due date'
    : dueDateHint(po.paymentTermsDays === null ? 'COMPANY_DEFAULT' : 'PO_TERMS', {
        poNumber: po.poNumber,
        poPaymentTermsDays: po.paymentTermsDays,
        companyDefaultDays: po.companyDefaultDays,
      });

  function followInvoiceDate(next: string) {
    if (manualDue) return;
    const due = defaultDue(next, po);
    if (due) form.setValue('dueDate', due, { shouldDirty: true });
  }

  function resetDue() {
    const due = defaultDue(form.getValues('invoiceDate'), po);
    if (due) form.setValue('dueDate', due, { shouldDirty: true });
    setManualDue(false);
    setDueReset(true);
  }

  function choose(next: File | undefined) {
    setFileError(null);
    if (!next) return;
    if (!TYPES.has(next.type)) {
      setFileError('Upload a PDF, PNG, JPEG or WebP file');
      return;
    }
    if (maxMb && next.size > maxMb * 1024 * 1024) {
      setFileError(`The file is larger than ${maxMb} MB`);
      return;
    }
    setFile(next);
  }

  async function submit(values: InvoiceFormValues) {
    if (!invoice) {
      const result = await createInvoiceAction(
        payload(values) as Parameters<typeof createInvoiceAction>[0],
      );
      if (!applyResult(result, form, 'Invoice created')) return;
      const { id } = result.data;
      if (file) {
        const upload = await uploadDocumentFile('INVOICE', id, file);
        if (!upload.ok) {
          toast.error(
            `The invoice was saved, but its document did not upload: ${upload.error} Upload it again from the Document card.`,
          );
        }
      }
      router.push(`/invoices/${id}`);
      return;
    }

    // Only what changed. A due date is sent when typed, or cleared back to the default.
    const changed = EDITABLE.filter((field) => Boolean(dirtyFields[field]));
    const data: Record<string, string> = Object.fromEntries(
      changed.map((field) => [field, values[field]]),
    );
    if (manualDue && dirtyFields.dueDate) data.dueDate = values.dueDate;
    else if (dueReset) data.dueDate = '';
    if (Object.keys(data).length === 0) {
      router.push(`/invoices/${invoice.id}`);
      return;
    }
    const result = await updateInvoiceAction({
      id: invoice.id,
      data: data as Parameters<typeof updateInvoiceAction>[0]['data'],
    });
    if (applyResult(result, form, 'Invoice saved')) {
      router.push(`/invoices/${invoice.id}`);
      router.refresh();
    }
  }

  const invoiceDateField = form.register('invoiceDate', {
    onChange: (event: { target: { value: string } }) => followInvoiceDate(event.target.value),
  });
  const dueDateField = form.register('dueDate', {
    onChange: () => {
      setManualDue(true);
      setDueReset(false);
    },
  });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(submit)}
      className="bg-card rounded-[var(--radius)] border"
    >
      <div className="p-6">
        <FieldGroup>
          <section className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">Invoice</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <span className="text-muted-foreground text-[13px]">Client</span>
                <span data-testid="invoice-client">{po.client}</span>
                <FieldDescription>From PO {po.poNumber}</FieldDescription>
              </Field>
              {invoice && (
                <Field>
                  <span className="text-muted-foreground text-[13px]">Purchase order</span>
                  <span>
                    PO {po.poNumber} · {po.project}
                  </span>
                </Field>
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.invoiceNumber)}>
                <FieldLabel htmlFor="invoice-number">Invoice number</FieldLabel>
                <Input
                  id="invoice-number"
                  autoComplete="off"
                  autoFocus={!invoice}
                  {...form.register('invoiceNumber')}
                />
                <FieldDescription>As issued by your accounting system.</FieldDescription>
                <FieldError errors={[errors.invoiceNumber]} />
              </Field>
              <Field data-invalid={Boolean(errors.invoiceDate)}>
                <FieldLabel htmlFor="invoice-date">Invoice date</FieldLabel>
                <Input id="invoice-date" type="date" {...invoiceDateField} />
                <FieldError errors={[errors.invoiceDate]} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.serviceId)}>
                <FieldLabel htmlFor="invoice-service">Service</FieldLabel>
                <Controller
                  control={form.control}
                  name="serviceId"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="invoice-service" className="w-full">
                        <SelectValue placeholder="Choose the service" />
                      </SelectTrigger>
                      <SelectContent>
                        {po.services.map((service) => (
                          <SelectItem key={service.id} value={service.id}>
                            {service.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldDescription>One of the PO’s services.</FieldDescription>
                <FieldError errors={[errors.serviceId]} />
              </Field>
              <Field data-invalid={Boolean(errors.amount)}>
                <FieldLabel htmlFor="invoice-amount">Amount ({po.currency})</FieldLabel>
                <Input
                  id="invoice-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  {...form.register('amount')}
                />
                <FieldDescription>
                  {value !== null ? formatMoney(value, po.currency) : 'Including taxes'}
                  {hints?.amount && ` · ${hints.amount}`}
                </FieldDescription>
                <FieldError errors={[errors.amount]} />
              </Field>
            </div>
            {over && total !== null && (
              <div
                role="alert"
                className="bg-warning-soft flex gap-2 rounded-[var(--radius-md)] border p-3 text-sm"
              >
                <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
                <p>
                  With this invoice, invoices on PO {po.poNumber} total{' '}
                  <strong>{formatMoney(total, po.currency)}</strong>, above its amount of{' '}
                  <strong>{formatMoney(poAmount, po.currency)}</strong>. You can still save it, for
                  example when the PO excludes tax.
                </p>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">Payment</h2>
            <Field data-invalid={Boolean(errors.dueDate)} className="sm:max-w-[50%]">
              <FieldLabel htmlFor="invoice-due">Due date</FieldLabel>
              <Input id="invoice-due" type="date" min={invoiceDate} {...dueDateField} />
              <FieldDescription data-testid="due-hint">
                {hint}
                {manualDue && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={resetDue}
                    >
                      Reset
                    </button>
                  </>
                )}
              </FieldDescription>
              <FieldError errors={[errors.dueDate]} />
            </Field>
            {!invoice && (
              <>
                <Controller
                  control={form.control}
                  name="alreadyPaid"
                  render={({ field }) => (
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(next) => field.onChange(next === true)}
                      />
                      Already paid
                    </label>
                  )}
                />
                {alreadyPaid && (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field data-invalid={Boolean(errors.paidAt)}>
                      <FieldLabel htmlFor="invoice-paid-at">Paid on</FieldLabel>
                      <Input
                        id="invoice-paid-at"
                        type="date"
                        min={invoiceDate}
                        {...form.register('paidAt')}
                      />
                      <FieldError errors={[errors.paidAt]} />
                    </Field>
                    <Field data-invalid={Boolean(errors.paymentReference)}>
                      <FieldLabel htmlFor="invoice-paid-ref">
                        Payment reference (optional)
                      </FieldLabel>
                      <Input
                        id="invoice-paid-ref"
                        autoComplete="off"
                        {...form.register('paymentReference')}
                      />
                      <FieldError errors={[errors.paymentReference]} />
                    </Field>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">Notes</h2>
            <Field data-invalid={Boolean(errors.description)}>
              <FieldLabel htmlFor="invoice-description">Notes (optional)</FieldLabel>
              <Textarea id="invoice-description" rows={3} {...form.register('description')} />
              <FieldError errors={[errors.description]} />
            </Field>
          </section>

          {!invoice && (
            <section className="flex flex-col gap-4">
              <h2 className="text-base font-semibold">Document</h2>
              {file ? (
                <div className="flex items-center justify-between gap-3 rounded-[var(--radius)] border p-3">
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
                    <span className="truncate">{file.name}</span>
                    <span className="text-muted-foreground num text-[13px]">
                      {formatBytes(file.size)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Remove the document"
                    onClick={() => setFile(null)}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              ) : (
                <label
                  className="hover:bg-accent focus-within:ring-ring data-[dragging=true]:bg-accent flex cursor-pointer flex-col items-center gap-2 rounded-[var(--radius)] border border-dashed p-6 text-center focus-within:ring-2 focus-within:ring-offset-2"
                  data-dragging={dragging}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    choose(event.dataTransfer.files[0]);
                  }}
                >
                  <Upload className="text-muted-foreground size-5" aria-hidden />
                  <span className="text-sm font-medium">Attach the invoice (optional)</span>
                  <span className="text-muted-foreground text-[13px]">
                    Drop a file here or choose one. PDF, PNG, JPEG or WebP, up to {maxMb} MB. Its
                    values are read for you to review after saving.
                  </span>
                  <input
                    type="file"
                    accept={ACCEPTED_TYPES}
                    className="sr-only"
                    aria-label="Choose the invoice document"
                    onChange={(event) => choose(event.target.files?.[0])}
                  />
                </label>
              )}
              {fileError && (
                <p role="alert" className="text-destructive text-sm">
                  {fileError}
                </p>
              )}
            </section>
          )}
        </FieldGroup>
      </div>
      <div className="bg-card sticky bottom-0 flex justify-end gap-2 rounded-b-[var(--radius)] border-t px-6 py-3">
        <Button asChild type="button" variant="outline">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {invoice ? 'Save invoice' : 'Create invoice'}
        </Button>
      </div>
    </form>
  );
}
