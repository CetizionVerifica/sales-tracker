'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  createProjectFormSchema,
  formatMoney,
  isIsoCurrency,
  parseAmount,
  updateProjectFormSchema,
} from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
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
import type { Option } from '../enquiries/form-options';
import { createProjectAction, updateProjectAction } from './actions';
import type { ProjectFormOptions } from './form-options';

/** Everything as the inputs hold it: strings, dates as YYYY-MM-DD. */
export interface ProjectFormValues {
  quotationId: string;
  name: string;
  /** '' = unassigned. */
  managerId: string;
  serviceIds: string[];
  revenue: string;
  currency: string;
  startDate: string;
  endDate: string;
  completionPct: string;
  description: string;
}

type EditableField = Exclude<keyof ProjectFormValues, 'quotationId'>;

const UNASSIGNED = '__none__';

const label = (option: Option) => (option.note ? `${option.name} (${option.note})` : option.name);

/** The revenue as it will be saved, or null while it doesn't parse yet. */
function preview(amount: string, currency: string): string | null {
  if (!amount || !isIsoCurrency(currency)) return null;
  const parsed = parseAmount(amount, currency);
  return parsed.ok ? formatMoney(parsed.value, currency) : null;
}

function pick(values: ProjectFormValues, fields: readonly EditableField[]) {
  return Object.fromEntries(fields.map((field) => [field, values[field]]));
}

/**
 * Create and edit share one full-page form (UI guide §4.3: projects are a larger form).
 * Create validates with the shared create schema. Edit sends, and validates, only the
 * fields this user may change (M8 Decision 6: the PM runs delivery, admins own the
 * commercial fields); the service checks the same rule. Raw values are submitted: dates
 * stay YYYY-MM-DD and the revenue stays as typed until the service converts it.
 */
export function ProjectForm({
  project,
  initial,
  editable,
  client,
  quotationNumber,
  options,
  cancelHref,
}: {
  /** Edit: the project's id and number. */
  project?: { id: string; number: string };
  initial: ProjectFormValues;
  /** Edit: the fields this user may change. Create: every field. */
  editable?: readonly EditableField[];
  client: string;
  quotationNumber: string;
  options: ProjectFormOptions;
  cancelHref: string;
}) {
  const router = useRouter();
  const can = (field: EditableField) => !editable || editable.includes(field);
  const createResolver = zodResolver(createProjectFormSchema, undefined, { raw: true });
  const updateResolver = zodResolver(updateProjectFormSchema, undefined, { raw: true });
  // With raw: true the parsed output type is unused, so the resolver is typed to the form
  // values (as in the quotation form). Edit validates only the fields it will send.
  const resolver: Resolver<ProjectFormValues> = project
    ? (values, context, opts) =>
        (updateResolver as unknown as Resolver<ProjectFormValues>)(
          pick(values, editable ?? []) as unknown as ProjectFormValues,
          context,
          opts,
        )
    : (values, context, opts) => {
        const { completionPct: _pct, ...fields } = values;
        return (createResolver as unknown as Resolver<ProjectFormValues>)(
          fields as ProjectFormValues,
          context,
          opts,
        );
      };
  const form = useForm<ProjectFormValues>({ resolver, defaultValues: initial });
  const { errors, isSubmitting } = form.formState;
  const [revenue, currency, startDate] = useWatch({
    control: form.control,
    name: ['revenue', 'currency', 'startDate'],
  });
  const formatted = preview(revenue, currency);

  async function submit(values: ProjectFormValues) {
    if (!project) {
      const { completionPct: _pct, ...fields } = values;
      const result = await createProjectAction(fields);
      if (applyResult(result, form, 'Project created')) {
        router.push(`/projects/${result.data.id}`);
      }
      return;
    }
    const result = await updateProjectAction({
      id: project.id,
      data: pick(values, editable ?? []) as Parameters<typeof updateProjectAction>[0]['data'],
    });
    if (applyResult(result, form, 'Project saved')) {
      router.push(`/projects/${project.id}`);
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
            <h2 className="text-base font-semibold">Project</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <span className="text-muted-foreground text-[13px]">Client</span>
                <span data-testid="project-client">{client}</span>
                <FieldDescription>From {quotationNumber}</FieldDescription>
              </Field>
              {options.managers && can('managerId') && (
                <Field data-invalid={Boolean(errors.managerId)}>
                  <FieldLabel htmlFor="project-manager">Project manager</FieldLabel>
                  <Controller
                    control={form.control}
                    name="managerId"
                    render={({ field }) => (
                      <Select
                        value={field.value || UNASSIGNED}
                        onValueChange={(value) => field.onChange(value === UNASSIGNED ? '' : value)}
                      >
                        <SelectTrigger id="project-manager" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNASSIGNED}>Assign later</SelectItem>
                          {(options.managers ?? []).map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              {label(option)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <FieldError errors={[errors.managerId]} />
                </Field>
              )}
            </div>
            {can('name') && (
              <Field data-invalid={Boolean(errors.name)}>
                <FieldLabel htmlFor="project-name">Name</FieldLabel>
                <Input id="project-name" autoComplete="off" {...form.register('name')} />
                <FieldError errors={[errors.name]} />
              </Field>
            )}
            {can('serviceIds') && (
              <FieldSet data-invalid={Boolean(errors.serviceIds)}>
                <FieldLegend variant="label">Services</FieldLegend>
                <Controller
                  control={form.control}
                  name="serviceIds"
                  render={({ field }) => (
                    <div className="grid grid-cols-2 gap-2">
                      {options.services.map((service) => (
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
                          {label(service)}
                        </label>
                      ))}
                    </div>
                  )}
                />
                {!project && <FieldDescription>From {quotationNumber}</FieldDescription>}
                <FieldError errors={[errors.serviceIds]} />
              </FieldSet>
            )}
          </section>

          {can('revenue') && (
            <section className="flex flex-col gap-4">
              <h2 className="text-base font-semibold">Revenue</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
                <Field data-invalid={Boolean(errors.revenue)}>
                  <FieldLabel htmlFor="project-revenue">Revenue</FieldLabel>
                  <Input
                    id="project-revenue"
                    inputMode="decimal"
                    autoComplete="off"
                    {...form.register('revenue')}
                  />
                  <FieldDescription>
                    {formatted ?? ''}
                    {!project && ` · From ${quotationNumber}`}
                  </FieldDescription>
                  <FieldError errors={[errors.revenue]} />
                </Field>
                <Field data-invalid={Boolean(errors.currency)}>
                  <FieldLabel htmlFor="project-currency">Currency</FieldLabel>
                  <Controller
                    control={form.control}
                    name="currency"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="project-currency" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {options.currencies.map((code) => (
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
            </section>
          )}

          {(can('startDate') || can('completionPct')) && (
            <section className="flex flex-col gap-4">
              <h2 className="text-base font-semibold">Schedule</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {can('startDate') && (
                  <Field data-invalid={Boolean(errors.startDate)}>
                    <FieldLabel htmlFor="project-start">Start (optional)</FieldLabel>
                    <Input id="project-start" type="date" {...form.register('startDate')} />
                    <FieldError errors={[errors.startDate]} />
                  </Field>
                )}
                {can('endDate') && (
                  <Field data-invalid={Boolean(errors.endDate)}>
                    <FieldLabel htmlFor="project-end">Planned end (optional)</FieldLabel>
                    <Input
                      id="project-end"
                      type="date"
                      min={startDate || undefined}
                      {...form.register('endDate')}
                    />
                    <FieldError errors={[errors.endDate]} />
                  </Field>
                )}
                {project && can('completionPct') && (
                  <Field data-invalid={Boolean(errors.completionPct)}>
                    <FieldLabel htmlFor="project-completion">Completion %</FieldLabel>
                    <Input
                      id="project-completion"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      {...form.register('completionPct')}
                    />
                    <FieldError errors={[errors.completionPct]} />
                  </Field>
                )}
              </div>
              {!project && (
                <FieldDescription>
                  The start can be a planned date; starting the project records the real one.
                </FieldDescription>
              )}
            </section>
          )}

          <Field data-invalid={Boolean(errors.description)}>
            <FieldLabel htmlFor="project-description">Scope and notes (optional)</FieldLabel>
            <Textarea id="project-description" rows={4} {...form.register('description')} />
            <FieldError errors={[errors.description]} />
          </Field>
        </FieldGroup>
      </div>
      <div className="bg-card sticky bottom-0 flex justify-end gap-2 rounded-b-[var(--radius)] border-t px-6 py-3">
        <Button asChild type="button" variant="outline">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {project ? 'Save project' : 'Create project'}
        </Button>
      </div>
    </form>
  );
}
