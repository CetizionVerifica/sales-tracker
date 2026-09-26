'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { changeOwnPasswordSchema } from '@sales-tracker/core/schemas';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { applyResult } from '@/lib/apply-result';
import { changePasswordAction } from './actions';

export function ChangePasswordForm() {
  const form = useForm({
    resolver: zodResolver(changeOwnPasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <form
      noValidate
      method="post"
      className="max-w-sm"
      onSubmit={form.handleSubmit(async (data) => {
        if (applyResult(await changePasswordAction(data), form, 'Password changed')) form.reset();
      })}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(errors.currentPassword)}>
          <FieldLabel htmlFor="current-password">Current password</FieldLabel>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            {...form.register('currentPassword')}
          />
          <FieldError errors={[errors.currentPassword]} />
        </Field>
        <Field data-invalid={Boolean(errors.newPassword)}>
          <FieldLabel htmlFor="new-password">New password</FieldLabel>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            {...form.register('newPassword')}
          />
          <FieldError errors={[errors.newPassword]} />
        </Field>
      </FieldGroup>
      <Button type="submit" className="mt-6" disabled={isSubmitting}>
        Change password
      </Button>
    </form>
  );
}
