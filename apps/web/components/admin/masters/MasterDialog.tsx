'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createMasterSchema } from '@sales-tracker/core/schemas';
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
export function MasterDialog({ kind, row }: { kind: 'sector' | 'service'; row?: MasterRowView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm({
    resolver: zodResolver(createMasterSchema),
    defaultValues: { name: row?.name ?? '', active: row?.active ?? true },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={row ? 'outline' : 'default'}>
          {row ? 'Edit' : `New ${LABEL[kind]}`}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row ? `Edit “${row.name}”` : `New ${LABEL[kind]}`}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          onSubmit={form.handleSubmit(async (data) => {
            const result = row
              ? await updateMasterAction({ kind, id: row.id, data })
              : await createMasterAction({ kind, data });
            if (applyResult(result, form, row ? 'Saved' : 'Created')) {
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
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={isSubmitting}>
              {row ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
