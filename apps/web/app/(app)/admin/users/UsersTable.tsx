'use client';

import { createColumnHelper } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { DataTable } from '@/components/data/DataTable';
import { RowActions } from '@/components/data/RowActions';
import { DateDisplay } from '@/components/display/DateDisplay';
import { UserAvatar } from '@/components/display/UserAvatar';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge } from '@/components/pipeline/StatusBadge';
import { ROLE_LABELS } from '@/lib/roles';
import { deactivateUserAction, reactivateUserAction } from './actions';
import { ResetPasswordDialog } from './ResetPasswordDialog';
import { UserSheet } from './UserSheet';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: keyof typeof ROLE_LABELS;
  active: boolean;
  createdAt: string;
}

const column = createColumnHelper<UserRow>();

type Open = 'edit' | 'reset' | 'toggle' | null;

/** One user's ⋯ menu and the sheet or dialog each item opens. */
function UserActions({ user, isSelf }: { user: UserRow; isSelf: boolean }) {
  const [open, setOpen] = useState<Open>(null);
  const close = (next: boolean) => !next && setOpen(null);
  return (
    <div className="flex justify-end">
      <RowActions
        label={user.name}
        actions={[
          { label: 'Edit user', onSelect: () => setOpen('edit') },
          { label: 'Reset password', onSelect: () => setOpen('reset') },
          ...(isSelf
            ? []
            : [
                {
                  label: user.active ? 'Deactivate' : 'Reactivate',
                  onSelect: () => setOpen('toggle'),
                  destructive: user.active,
                },
              ]),
        ]}
      />
      <UserSheet
        mode="edit"
        user={user}
        isSelf={isSelf}
        open={open === 'edit'}
        onOpenChange={close}
      />
      <ResetPasswordDialog user={user} open={open === 'reset'} onOpenChange={close} />
      {!isSelf && (
        <ConfirmDialog
          open={open === 'toggle'}
          onOpenChange={close}
          variant={user.active ? 'destructive' : 'outline'}
          label={user.active ? 'Deactivate' : 'Reactivate'}
          title={user.active ? `Deactivate ${user.name}?` : `Reactivate ${user.name}?`}
          description={
            user.active
              ? 'They are signed out everywhere and cannot sign in until reactivated.'
              : 'They can sign in again with their current password.'
          }
          success={user.active ? `${user.name} deactivated` : `${user.name} reactivated`}
          run={() =>
            user.active
              ? deactivateUserAction({ id: user.id })
              : reactivateUserAction({ id: user.id })
          }
        />
      )}
    </div>
  );
}

export function UsersTable({
  currentUserId,
  rows,
  filtered,
  ...paging
}: {
  currentUserId: string;
  rows: UserRow[];
  total: number;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filtered: boolean;
}) {
  // Memoised: flexRender treats cell renderers as components, so new functions on every
  // render would remount the cells and close any open dialog (e.g. after a refresh).
  const columns = useMemo(
    () => [
      column.accessor('name', {
        header: 'Name',
        meta: { fixed: true },
        cell: (c) => <UserAvatar name={c.getValue()} showName className="font-medium" />,
      }),
      column.accessor('email', { header: 'Email' }),
      column.accessor('role', { header: 'Role', cell: (c) => ROLE_LABELS[c.getValue()] }),
      column.accessor('active', {
        header: 'Status',
        cell: (c) =>
          c.getValue() ? (
            <MarkBadge tone="success">Active</MarkBadge>
          ) : (
            <MarkBadge>Inactive</MarkBadge>
          ),
      }),
      column.accessor('createdAt', {
        header: 'Created',
        cell: (c) => <DateDisplay value={c.getValue()} withTime />,
      }),
      column.display({
        id: 'actions',
        meta: { fixed: true },
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row: { original } }) => (
          <UserActions user={original} isSelf={original.id === currentUserId} />
        ),
      }),
    ],
    [currentUserId],
  );

  return (
    <DataTable
      id="users"
      columns={columns}
      data={rows}
      getRowId={(u) => u.id}
      sortable={['name', 'email', 'createdAt']}
      empty={
        <EmptyState
          message={filtered ? 'No users match these filters.' : 'No users yet. Add the first one.'}
        />
      }
      mobileCard={(u) => (
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <span className="font-medium">{u.name}</span>
            <span className="text-muted-foreground text-[13px]">
              {ROLE_LABELS[u.role]} · {u.email}
            </span>
          </div>
          <UserActions user={u} isSelf={u.id === currentUserId} />
        </div>
      )}
      {...paging}
    />
  );
}
