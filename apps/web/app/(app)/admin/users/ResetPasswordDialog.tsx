'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { resetPasswordSchema } from '@sales-tracker/core/schemas';
import { useState } from 'react';
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
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { applyResult } from '@/lib/apply-result';
import { resetPasswordAction } from './actions';
import type { UserRow } from './UsersTable';

/** 16 characters from an unambiguous alphabet, from the browser's CSPRNG. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function ResetPasswordDialog({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: { password: string }) {
    const result = await resetPasswordAction({ id: user.id, data: values });
    if (applyResult(result, form, 'Password reset')) setIssued(values.password);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setIssued(null); // the temporary password is shown once
          form.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Reset password
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password for {user.name}</DialogTitle>
          <DialogDescription>
            They are signed out everywhere. Share the temporary password with them securely; they
            can change it under “Change password”.
          </DialogDescription>
        </DialogHeader>
        {issued ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">Temporary password (shown only now):</p>
            <code className="bg-muted rounded px-3 py-2 font-mono" data-testid="issued-password">
              {issued}
            </code>
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FieldGroup>
              <Field data-invalid={Boolean(errors.password)}>
                <FieldLabel htmlFor={`reset-${user.id}`}>Temporary password</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id={`reset-${user.id}`}
                    autoComplete="off"
                    {...form.register('password')}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      form.setValue('password', generatePassword(), { shouldValidate: true })
                    }
                  >
                    Generate
                  </Button>
                </div>
                <FieldError errors={[errors.password]} />
              </Field>
            </FieldGroup>
            <DialogFooter className="mt-6">
              <Button type="submit" disabled={isSubmitting}>
                Reset password
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
