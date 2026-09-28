'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  createPurchaseOrderFormSchema,
  formatMoney,
  isIsoCurrency,
  parseAmount,
  updatePurchaseOrderFormSchema,
} from '@sales-tracker/core/schemas';
import { AlertTriangle, FileText, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
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
import { ACCEPTED_TYPES, formatBytes } from '@/lib/document-labels';
import { uploadDocumentFile } from '@/lib/document-upload';
import { createPurchaseOrderAction, updatePurchaseOrderAction } from './actions';

/** Everything as the inputs hold it: strings, dates as YYYY-MM-DD. */
export interface PurchaseOrderFormValues {
  projectId: string;
  poNumber: string;
  receivedDate: string;
  amount: string;
  currency: string;
  serviceIds: string[];
  paymentTerms: string;
  paymentTermsDays: string;
  description: string;
}

type EditableField = Exclude<keyof PurchaseOrderFormValues, 'projectId'>;
const EDITABLE: readonly EditableField[] = [
  'poNumber',
  'receivedDate',
  'amount',
  'currency',
  'serviceIds',
  'paymentTerms',
  'paymentTermsDays',
  'description',
];

/** What the form knows about the project the PO is on. */
export interface PurchaseOrderFormProject {
  number: string;
  client: string;
  quotationNumber: string;
  services: { id: string; name: string }[];
  currency: string;
  /** Minor units as strings: no BigInt reaches the browser. */
  revenueMinor: string;
  /** Live POs in the project currency, other than this one. */
  otherPosMinor: string;
}

const TYPES = new Set(ACCEPTED_TYPES.split(','));

/** The amount as it will be saved, or null while it doesn't parse yet. */
function parsed(amount: string, currency: string): bigint | null {
  if (!amount || !isIsoCurrency(currency)) return null;
  const result = parseAmount(amount, currency);
  return result.ok ? result.value : null;
}

/**
 * Create and edit share one full-page form (UI guide §4.3: POs are a larger form). Create
 * starts from getPurchaseOrderDraft; after the PO is saved the file goes to the M7 upload
 * route, and a failed upload keeps the PO (M9 Decision 3). Edit sends only changed fields.
 * Raw values are submitted: dates stay YYYY-MM-DD and the amount stays as typed until the
 * service converts it.
 */
export function PurchaseOrderForm({
  purchaseOrder,
  initial,
  project,
  currencies,
  hints,
  maxMb,
  cancelHref,
}: {
  /** Edit: the PO's id and number. */
  purchaseOrder?: { id: string; poNumber: string };
  initial: PurchaseOrderFormValues;
  project: PurchaseOrderFormProject;
  currencies: string[];
  /** Create: where the pre-filled values came from. */
  hints?: { amount: string | null; receivedDate: string | null };
  /** Create: the largest document accepted. */
  maxMb?: number;
  cancelHref: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // With raw: true the parsed output type is unused, so the resolver is typed to the form
  // values (as in the project form).
  const resolver = (purchaseOrder
    ? zodResolver(updatePurchaseOrderFormSchema, undefined, { raw: true })
    : zodResolver(createPurchaseOrderFormSchema, undefined, {
        raw: true,
      })) as unknown as Resolver<PurchaseOrderFormValues>;
  const editResolver: Resolver<PurchaseOrderFormValues> = (values, context, options) => {
    const { projectId: _project, ...fields } = values;
    return resolver(fields as PurchaseOrderFormValues, context, options);
  };
  const form = useForm<PurchaseOrderFormValues>({
    resolver: purchaseOrder ? editResolver : resolver,
    defaultValues: initial,
  });
  const { errors, isSubmitting, dirtyFields } = form.formState;
  const [amount, currency] = useWatch({ control: form.control, name: ['amount', 'currency'] });

  const value = parsed(amount, currency);
  const inProjectCurrency = currency === project.currency && value !== null;
  const total = inProjectCurrency ? BigInt(project.otherPosMinor) + value : null;
  const revenue = BigInt(project.revenueMinor);
  const over = total !== null && total > revenue;

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

  async function submit(values: PurchaseOrderFormValues) {
    if (!purchaseOrder) {
      const result = await createPurchaseOrderAction(values);
      if (!applyResult(result, form, 'Purchase order created')) return;
      const { id } = result.data;
      if (file) {
        const upload = await uploadDocumentFile('PURCHASE_ORDER', id, file);
        if (!upload.ok) {
          toast.error(
            `The PO was saved, but its document did not upload: ${upload.error} Upload it again from the Document card.`,
          );
        }
      }
      router.push(`/purchase-orders/${id}`);
      return;
    }

    // Only what changed; an amount and its currency travel together.
    const changed = EDITABLE.filter((field) =>
      field === 'amount' || field === 'currency'
        ? dirtyFields.amount || dirtyFields.currency
        : Boolean(dirtyFields[field]),
    );
    if (changed.length === 0) {
      router.push(`/purchase-orders/${purchaseOrder.id}`);
      return;
    }
    const data = Object.fromEntries(changed.map((field) => [field, values[field]]));
    const result = await updatePurchaseOrderAction({
      id: purchaseOrder.id,
      data: data as Parameters<typeof updatePurchaseOrderAction>[0]['data'],
    });
    if (applyResult(result, form, 'Purchase order saved')) {
      router.push(`/purchase-orders/${purchaseOrder.id}`);
      router.refresh();
    }
  }

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(submit)}
      className="bg-card rounded-[var(--radius)] border"
    >
      <div className="p-6">
        <FieldGroup>
          <section className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">Purchase order</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <span className="text-muted-foreground text-[13px]">Client</span>
                <span data-testid="po-client">{project.client}</span>
                <FieldDescription>From {project.number}</FieldDescription>
              </Field>
              {/* On create the project picker above names it already. */}
              {purchaseOrder && (
                <Field>
                  <span className="text-muted-foreground text-[13px]">Project</span>
                  <span>{project.number}</span>
                </Field>
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.poNumber)}>
                <FieldLabel htmlFor="po-number">PO number</FieldLabel>
                <Input
                  id="po-number"
                  autoComplete="off"
                  autoFocus={!purchaseOrder}
                  {...form.register('poNumber')}
                />
                <FieldDescription>As printed on the client’s PO.</FieldDescription>
                <FieldError errors={[errors.poNumber]} />
              </Field>
              <Field data-invalid={Boolean(errors.receivedDate)}>
                <FieldLabel htmlFor="po-received">Received on</FieldLabel>
                <Input id="po-received" type="date" {...form.register('receivedDate')} />
                {hints?.receivedDate && <FieldDescription>{hints.receivedDate}</FieldDescription>}
                <FieldError errors={[errors.receivedDate]} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
              <Field data-invalid={Boolean(errors.amount)}>
                <FieldLabel htmlFor="po-amount">Amount</FieldLabel>
                <Input
                  id="po-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  {...form.register('amount')}
                />
                <FieldDescription>
                  {value !== null && isIsoCurrency(currency) ? formatMoney(value, currency) : ''}
                  {hints?.amount && ` · ${hints.amount}`}
                </FieldDescription>
                <FieldError errors={[errors.amount]} />
              </Field>
              <Field data-invalid={Boolean(errors.currency)}>
                <FieldLabel htmlFor="po-currency">Currency</FieldLabel>
                <Controller
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="po-currency" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {currencies.map((code) => (
                          <SelectItem key={code} value={code}>
                            {code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.currency]} />
              </Field>
            </div>
            {over && total !== null && (
              <div
                role="alert"
                className="bg-warning-soft flex gap-2 rounded-[var(--radius-md)] border p-3 text-sm"
              >
                <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
                <p>
                  With this PO, POs on {project.number} total{' '}
                  <strong>{formatMoney(total, project.currency)}</strong>, above its revenue of{' '}
                  <strong>{formatMoney(revenue, project.currency)}</strong>. You can still save it,
                  for example when the PO includes tax.
                </p>
              </div>
            )}
            <FieldSet data-invalid={Boolean(errors.serviceIds)}>
              <FieldLegend variant="label">Services</FieldLegend>
              <Controller
                control={form.control}
                name="serviceIds"
                render={({ field }) => (
                  <div className="grid grid-cols-2 gap-2">
                    {project.services.map((service) => (
                      <label key={service.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={field.value.includes(service.id)}
                          onCheckedChange={(next) =>
                            field.onChange(
                              next === true
                                ? [...field.value, service.id]
                                : field.value.filter((id) => id !== service.id),
                            )
                          }
                        />
                        {service.name}
                      </label>
                    ))}
                  </div>
                )}
              />
              <FieldDescription>The project’s services.</FieldDescription>
              <FieldError errors={[errors.serviceIds]} />
            </FieldSet>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">Payment terms</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
              <Field data-invalid={Boolean(errors.paymentTerms)}>
                <FieldLabel htmlFor="po-terms">Terms (optional)</FieldLabel>
                <Input id="po-terms" autoComplete="off" {...form.register('paymentTerms')} />
                <FieldDescription>As the client wrote them.</FieldDescription>
                <FieldError errors={[errors.paymentTerms]} />
              </Field>
              <Field data-invalid={Boolean(errors.paymentTermsDays)}>
                <FieldLabel htmlFor="po-days">Net days (optional)</FieldLabel>
                <Input
                  id="po-days"
                  inputMode="numeric"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  {...form.register('paymentTermsDays')}
                />
                <FieldError errors={[errors.paymentTermsDays]} />
              </Field>
            </div>
            <FieldDescription>
              Net days set invoice due dates on this PO. Leave them empty to use the company
              default.
            </FieldDescription>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">Notes</h2>
            <Field data-invalid={Boolean(errors.description)}>
              <FieldLabel htmlFor="po-description">Scope and notes (optional)</FieldLabel>
              <Textarea id="po-description" rows={4} {...form.register('description')} />
              <FieldError errors={[errors.description]} />
            </Field>
          </section>

          {!purchaseOrder && (
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
                  className="hover:bg-accent focus-within:ring-ring flex cursor-pointer flex-col items-center gap-2 rounded-[var(--radius)] border border-dashed p-6 text-center focus-within:ring-2 focus-within:ring-offset-2 data-[dragging=true]:bg-accent"
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
                  <span className="text-sm font-medium">Attach the client’s PO (optional)</span>
                  <span className="text-muted-foreground text-[13px]">
                    Drop a file here or choose one. PDF, PNG, JPEG or WebP, up to {maxMb} MB. Its
                    values are read for you to review after saving.
                  </span>
                  <input
                    ref={input}
                    type="file"
                    accept={ACCEPTED_TYPES}
                    className="sr-only"
                    aria-label="Choose the PO document"
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
          {purchaseOrder ? 'Save purchase order' : 'Create purchase order'}
        </Button>
      </div>
    </form>
  );
}
