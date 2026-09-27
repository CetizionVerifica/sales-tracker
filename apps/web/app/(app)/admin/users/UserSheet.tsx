'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createUserSchema, updateUserSchema } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Controller, useForm, type FieldError as RhfFieldError } from 'react-hook-form';
import { Button } from '@/components/ui/button';
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

function DialogShell({
  trigger,
  title,
  open,
  onOpenChange,
  children,
}: {
  trigger: ReactNode;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CreateUserDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm({
    resolver: zodResolver(createUserSchema),
    defaultValues: { name: '', email: '', role: 'SALES' as Role, password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <DialogShell
      trigger={<Button size="sm">New user</Button>}
      title="New user"
      open={open}
      onOpenChange={setOpen}
    >
      <form
        noValidate
        onSubmit={form.handleSubmit(async (values) => {
          if (applyResult(await createUserAction(values), form, 'User created')) {
            setOpen(false);
            form.reset();
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
        <DialogFooter className="mt-6">
          <Button type="submit" disabled={isSubmitting}>
            Create user
          </Button>
        </DialogFooter>
      </form>
    </DialogShell>
  );
}

function EditUserDialog({ user, isSelf }: { user: UserRow; isSelf: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm({
    resolver: zodResolver(updateUserSchema),
    defaultValues: { name: user.name, email: user.email, role: user.role },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <DialogShell
      trigger={
        <Button size="sm" variant="outline">
          Edit
        </Button>
      }
      title={`Edit ${user.name}`}
      open={open}
      onOpenChange={setOpen}
    >
      <form
        noValidate
        onSubmit={form.handleSubmit(async (values) => {
          if (
            applyResult(await updateUserAction({ id: user.id, data: values }), form, 'User updated')
          ) {
            setOpen(false);
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
        <DialogFooter className="mt-6">
          <Button type="submit" disabled={isSubmitting}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogShell>
  );
}

export function UserDialog(
  props: { mode: 'create' } | { mode: 'edit'; user: UserRow; isSelf: boolean },
) {
  return props.mode === 'create' ? (
    <CreateUserDialog />
  ) : (
    <EditUserDialog user={props.user} isSelf={props.isSelf} />
  );
}
