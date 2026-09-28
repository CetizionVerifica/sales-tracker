'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createSectorSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
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
import { createMasterAction, updateMasterAction } from './actions';
import type { MasterRowView } from './MastersTable';

const LABEL = { sector: 'sector', service: 'service' };

/** Create (no row) or edit (row) a sector/service: name and the active flag. */
export function MasterDialog({
  kind,
  row,
  open: controlledOpen,
  onOpenChange,
}: {
  kind: 'sector' | 'service';
  row?: MasterRowView;
  /** Controlled from a row's ⋯ menu: no trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (next: boolean) => (controlled ? onOpenChange?.(next) : setOwnOpen(next));
  const noun = LABEL[kind];
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const form = useForm({
    // Both kinds validate against the sector schema (a strict superset): `isOther` is simply
    // unused and discarded server-side for a service (its own schema re-parses without it).
    resolver: zodResolver(createSectorSchema),
    defaultValues: {
      name: row?.name ?? '',
      active: row?.active ?? true,
      isOther: row?.isOther ?? false,
    },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          <Button variant={row ? 'outline' : 'default'}>{row ? 'Edit' : `New ${noun}`}</Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row ? `Edit “${row.name}”` : `New ${noun}`}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          onSubmit={form.handleSubmit(async (data) => {
            const result = row
              ? await updateMasterAction({ kind, id: row.id, data })
              : await createMasterAction({ kind, data });
            if (applyResult(result, form, row ? `${Noun} saved` : `${Noun} created`)) {
              setOpen(false);
              if (!row) form.reset();
              router.refresh();
            }
          })}
        >
          <FieldGroup>
            <Field data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor={`${kind}-name-${row?.id ?? 'new'}`}>Name</FieldLabel>
              <Input id={`${kind}-name-${row?.id ?? 'new'}`} {...form.register('name')} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field orientation="horizontal">
              <Controller
                control={form.control}
                name="active"
                render={({ field }) => (
                  <Checkbox
                    id={`${kind}-active-${row?.id ?? 'new'}`}
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked === true)}
                  />
                )}
              />
              <FieldLabel htmlFor={`${kind}-active-${row?.id ?? 'new'}`}>
                Active (shown in pickers)
              </FieldLabel>
            </Field>
            {kind === 'sector' && (
              <Field orientation="horizontal">
                <Controller
                  control={form.control}
                  name="isOther"
                  render={({ field }) => (
                    <Checkbox
                      id={`sector-isOther-${row?.id ?? 'new'}`}
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                  )}
                />
                <FieldLabel htmlFor={`sector-isOther-${row?.id ?? 'new'}`}>
                  Group into “Other sectors” on reports
                </FieldLabel>
              </Field>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={isSubmitting}>
              {row ? `Save ${noun}` : `Create ${noun}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
