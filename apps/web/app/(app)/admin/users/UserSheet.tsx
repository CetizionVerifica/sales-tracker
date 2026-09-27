'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createUserSchema, updateUserSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm, type FieldError as RhfFieldError } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { FormSheet } from '@/components/layout/FormSheet';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { applyResult } from '@/lib/apply-result';
import { ROLE_LABELS } from '@/lib/roles';
import { createUserAction, updateUserAction } from './actions';
import type { UserRow } from './UsersTable';

type Role = keyof typeof ROLE_LABELS;
const ROLES = Object.entries(ROLE_LABELS) as [Role, string][];

function RoleSelect({
  value,
  onChange,
  error,
  disabled,
}: {
  value: Role | undefined;
  onChange: (role: Role) => void;
  error?: RhfFieldError;
  disabled?: boolean;
}) {
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor="user-role">Role</FieldLabel>
      <Select value={value} onValueChange={(next) => onChange(next as Role)} disabled={disabled}>
        <SelectTrigger id="user-role" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLES.map(([role, label]) => (
            <SelectItem key={role} value={role}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError errors={[error]} />
    </Field>
  );
}

function CreateUserForm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(createUserSchema),
    defaultValues: { name: '', email: '', role: 'SALES' as Role, password: '' },
  });
  const { errors, isSubmitting, isDirty } = form.formState;

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
      title="New user"
      description="They sign in with this email and the initial password you set."
      submitLabel="Create user"
      submitting={isSubmitting}
      dirty={isDirty}
      onSubmit={form.handleSubmit(async (values) => {
        if (applyResult(await createUserAction(values), form, 'User created')) {
          form.reset();
          onOpenChange(false);
          router.refresh();
        }
      })}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(errors.name)}>
          <FieldLabel htmlFor="user-name">Name</FieldLabel>
          <Input id="user-name" {...form.register('name')} />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={Boolean(errors.email)}>
          <FieldLabel htmlFor="user-email">Email</FieldLabel>
          <Input id="user-email" type="email" {...form.register('email')} />
          <FieldError errors={[errors.email]} />
        </Field>
        <Controller
          control={form.control}
          name="role"
          render={({ field }) => (
            <RoleSelect value={field.value} onChange={field.onChange} error={errors.role} />
          )}
        />
        <Field data-invalid={Boolean(errors.password)}>
          <FieldLabel htmlFor="user-password">Initial password</FieldLabel>
          <Input id="user-password" autoComplete="off" {...form.register('password')} />
          <FieldError errors={[errors.password]} />
        </Field>
      </FieldGroup>
    </FormSheet>
  );
}

function EditUserForm({
  user,
  isSelf,
  open,
  onOpenChange,
}: {
  user: UserRow;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(updateUserSchema),
    defaultValues: { name: user.name, email: user.email, role: user.role },
  });
  const { errors, isSubmitting, isDirty } = form.formState;

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
      title={`Edit ${user.name}`}
      submitLabel="Save user"
      submitting={isSubmitting}
      dirty={isDirty}
      onSubmit={form.handleSubmit(async (values) => {
        if (
          applyResult(await updateUserAction({ id: user.id, data: values }), form, 'User saved')
        ) {
          onOpenChange(false);
          router.refresh();
        }
      })}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(errors.name)}>
          <FieldLabel htmlFor="user-name">Name</FieldLabel>
          <Input id="user-name" {...form.register('name')} />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={Boolean(errors.email)}>
          <FieldLabel htmlFor="user-email">Email</FieldLabel>
          <Input id="user-email" type="email" {...form.register('email')} />
          <FieldError errors={[errors.email]} />
        </Field>
        {/* The service also rejects self role changes; disabling just explains it early. */}
        <Controller
          control={form.control}
          name="role"
          render={({ field }) => (
            <RoleSelect
              value={field.value}
              onChange={field.onChange}
              error={errors.role}
              disabled={isSelf}
            />
          )}
        />
      </FieldGroup>
    </FormSheet>
  );
}

/** Create or edit a user in the side sheet (UI guide §4.3); opened by the caller. */
export function UserSheet(
  props: { open: boolean; onOpenChange: (open: boolean) => void } & (
    { mode: 'create' } | { mode: 'edit'; user: UserRow; isSelf: boolean }
  ),
) {
  return props.mode === 'create' ? (
    <CreateUserForm open={props.open} onOpenChange={props.onOpenChange} />
  ) : (
    <EditUserForm
      user={props.user}
      isSelf={props.isSelf}
      open={props.open}
      onOpenChange={props.onOpenChange}
    />
  );
}

/** "New user" in the page header. */
export function NewUserButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>New user</Button>
      <UserSheet mode="create" open={open} onOpenChange={setOpen} />
    </>
  );
}
