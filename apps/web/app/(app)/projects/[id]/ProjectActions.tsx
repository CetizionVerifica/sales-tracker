'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  changeProjectStatusSchema,
  projectManagerFormSchema,
  projectProgressFormSchema,
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { applyResult } from '@/lib/apply-result';
import type { Option } from '../../enquiries/form-options';
import { changeProjectStatusAction, updateProjectAction } from '../actions';

type Target = 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';

interface StatusFormValues {
  id: string;
  to: Target;
  startDate?: string;
  holdReason?: string;
  completedDate?: string;
  cancelReason?: string;
}

const COPY: Record<
  Target,
  { label: string; resume?: string; title: string; description: string; success: string }
> = {
  IN_PROGRESS: {
    label: 'Start project',
    resume: 'Resume',
    title: 'Start the project',
    description: 'Record when work began.',
    success: 'Project started',
  },
  ON_HOLD: {
    label: 'Put on hold',
    title: 'Put on hold',
    description: 'Say why work has paused, so everyone following the project knows.',
    success: 'Project on hold',
  },
  COMPLETED: {
    label: 'Mark completed',
    title: 'Mark completed',
    description: 'Completion is set to 100%. A completed project cannot be reopened.',
    success: 'Project completed',
  },
  CANCELLED: {
    label: 'Cancel project',
    title: 'Cancel project',
    description:
      'The client has withdrawn. A cancelled project keeps its progress and cannot be reopened.',
    success: 'Project cancelled',
  },
};

/**
 * One dialog per status move, asking only for what the move needs (M8 status machine): a
 * start date when the project has none yet, the hold or cancel reason, or the completed
 * date. Cancelling is admin-only and destructive (Decision 12).
 */
export function ProjectStatusDialog({
  id,
  to,
  from,
  startDate,
  holdReason,
  today,
}: {
  id: string;
  to: Target;
  from: 'NOT_STARTED' | 'IN_PROGRESS' | 'ON_HOLD';
  /** The stored start date (YYYY-MM-DD), or '' when the project has not started. */
  startDate: string;
  /** Shown when resuming from hold. */
  holdReason?: string | null;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const copy = COPY[to];
  const resuming = to === 'IN_PROGRESS' && from === 'ON_HOLD';
  const needsStart = !startDate && (to === 'IN_PROGRESS' || to === 'ON_HOLD');
  const defaults: StatusFormValues =
    to === 'COMPLETED'
      ? { id, to, completedDate: today }
      : to === 'CANCELLED'
        ? { id, to, cancelReason: '' }
        : to === 'ON_HOLD'
          ? { id, to, holdReason: '', ...(needsStart && { startDate: today }) }
          : { id, to, ...(needsStart && { startDate: today }) };
  const form = useForm<StatusFormValues>({
    resolver: zodResolver(changeProjectStatusSchema, undefined, {
      raw: true,
    }) as unknown as Resolver<StatusFormValues>,
    defaultValues: defaults,
  });
  const { errors, isSubmitting } = form.formState;
  const label = resuming ? copy.resume! : copy.label;
  const destructive = to === 'CANCELLED';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset(defaults);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant={
            to === 'COMPLETED' || (to === 'IN_PROGRESS' && !resuming) ? 'default' : 'outline'
          }
        >
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{resuming ? 'Resume the project' : copy.title}</DialogTitle>
          <DialogDescription>
            {resuming && holdReason ? `On hold: ${holdReason}` : copy.description}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(async (values) => {
            const result = await changeProjectStatusAction(
              values as Parameters<typeof changeProjectStatusAction>[0],
            );
            if (applyResult(result, form, copy.success)) {
              setOpen(false);
              router.refresh();
            }
          })}
        >
          {needsStart && (
            <Field data-invalid={Boolean(errors.startDate)}>
              <FieldLabel htmlFor={`project-${to}-start`}>Started on</FieldLabel>
              <Input
                id={`project-${to}-start`}
                type="date"
                max={today}
                {...form.register('startDate')}
              />
              <FieldError errors={[errors.startDate]} />
            </Field>
          )}
          {to === 'ON_HOLD' && (
            <Field data-invalid={Boolean(errors.holdReason)}>
              <FieldLabel htmlFor="project-hold-reason">Why is it on hold?</FieldLabel>
              <Textarea id="project-hold-reason" rows={3} {...form.register('holdReason')} />
              <FieldError errors={[errors.holdReason]} />
            </Field>
          )}
          {to === 'COMPLETED' && (
            <Field data-invalid={Boolean(errors.completedDate)}>
              <FieldLabel htmlFor="project-completed">Completed on</FieldLabel>
              <Input
                id="project-completed"
                type="date"
                min={startDate || undefined}
                max={today}
                {...form.register('completedDate')}
              />
              <FieldError errors={[errors.completedDate]} />
            </Field>
          )}
          {to === 'CANCELLED' && (
            <Field data-invalid={Boolean(errors.cancelReason)}>
              <FieldLabel htmlFor="project-cancel-reason">Why was it cancelled?</FieldLabel>
              <Textarea id="project-cancel-reason" rows={3} {...form.register('cancelReason')} />
              <FieldError errors={[errors.cancelReason]} />
            </Field>
          )}
          <DialogFooter className="mt-2">
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              disabled={isSubmitting}
            >
              {label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const QUICK_PICKS = [25, 50, 75];

/** The assigned PM (or an admin) nudges completion without opening the edit page. */
export function UpdateProgress({ id, value }: { id: string; value: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm<{ completionPct: string }>({
    resolver: zodResolver(projectProgressFormSchema, undefined, {
      raw: true,
    }) as unknown as Resolver<{ completionPct: string }>,
    defaultValues: { completionPct: String(value) },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) form.reset({ completionPct: String(value) });
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          Update progress
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={form.handleSubmit(async (values) => {
            const result = await updateProjectAction({ id, data: values });
            if (applyResult(result, form, 'Progress updated')) {
              setOpen(false);
              router.refresh();
            }
          })}
        >
          <Field data-invalid={Boolean(errors.completionPct)}>
            <FieldLabel htmlFor="project-progress">Completion %</FieldLabel>
            <Input
              id="project-progress"
              type="number"
              min={0}
              max={100}
              step={1}
              {...form.register('completionPct')}
            />
            <FieldError errors={[errors.completionPct]} />
          </Field>
          <div className="flex gap-1">
            {QUICK_PICKS.map((pct) => (
              <Button
                key={pct}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => form.setValue('completionPct', String(pct))}
              >
                {pct}%
              </Button>
            ))}
          </div>
          <Button type="submit" size="sm" disabled={isSubmitting}>
            Update progress
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

const UNASSIGNED = '__none__';

/** Admins move a project to another PM, or back to unassigned (M8 Decision 5). */
export function ReassignDialog({
  id,
  number,
  managerId,
  managers,
}: {
  id: string;
  number: string;
  managerId: string | null;
  managers: Option[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm<{ managerId: string }>({
    resolver: zodResolver(projectManagerFormSchema, undefined, {
      raw: true,
    }) as unknown as Resolver<{ managerId: string }>,
    defaultValues: { managerId: managerId ?? '' },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Reassign
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign {number}?</DialogTitle>
          <DialogDescription>
            The new manager sees the project straight away; the current one no longer does.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(async (values) => {
            const result = await updateProjectAction({ id, data: values });
            if (applyResult(result, form, 'Project reassigned')) {
              setOpen(false);
              router.refresh();
            }
          })}
        >
          <Field data-invalid={Boolean(errors.managerId)}>
            <FieldLabel htmlFor="project-reassign">Project manager</FieldLabel>
            <Controller
              control={form.control}
              name="managerId"
              render={({ field }) => (
                <Select
                  value={field.value || UNASSIGNED}
                  onValueChange={(value) => field.onChange(value === UNASSIGNED ? '' : value)}
                >
                  <SelectTrigger id="project-reassign" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {managers.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.note ? `${option.name} (${option.note})` : option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <FieldError errors={[errors.managerId]} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              Reassign project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
