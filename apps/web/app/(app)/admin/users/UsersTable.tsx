'use client';

import { createColumnHelper } from '@tanstack/react-table';
import { useMemo } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { DataTable } from '@/components/data-table/DataTable';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format';
import { ROLE_LABELS } from '@/lib/roles';
import { deactivateUserAction, reactivateUserAction } from './actions';
import { ResetPasswordDialog } from './ResetPasswordDialog';
import { UserDialog } from './UserDialog';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: keyof typeof ROLE_LABELS;
  active: boolean;
  createdAt: string;
}

const column = createColumnHelper<UserRow>();

export function UsersTable({
  currentUserId,
  rows,
  ...paging
}: {
  currentUserId: string;
  rows: UserRow[];
  total: number;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}) {
  // Memoised: flexRender treats cell renderers as components, so new functions on every
  // render would remount the cells and close any open dialog (e.g. after a refresh).
  const columns = useMemo(
    () => [
      column.accessor('name', { header: 'Name' }),
      column.accessor('email', { header: 'Email' }),
      column.accessor('role', { header: 'Role', cell: (c) => ROLE_LABELS[c.getValue()] }),
      column.accessor('active', {
        header: 'Status',
        cell: (c) =>
          c.getValue() ? (
            <Badge variant="secondary">Active</Badge>
          ) : (
            <Badge variant="outline">Inactive</Badge>
          ),
      }),
      column.accessor('createdAt', {
        header: 'Created',
        cell: (c) => formatDateTime(c.getValue()),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row: { original: user } }) => (
          <div className="flex justify-end gap-2">
            <UserDialog mode="edit" user={user} isSelf={user.id === currentUserId} />
            <ResetPasswordDialog user={user} />
            {user.id !== currentUserId &&
              (user.active ? (
                <ConfirmButton
                  label="Deactivate"
                  title={`Deactivate ${user.name}?`}
                  description="They are signed out everywhere and cannot sign in until reactivated."
                  success={`${user.name} deactivated`}
                  run={() => deactivateUserAction({ id: user.id })}
                />
              ) : (
                <ConfirmButton
                  label="Reactivate"
                  title={`Reactivate ${user.name}?`}
                  description="They can sign in again with their current password."
                  success={`${user.name} reactivated`}
                  run={() => reactivateUserAction({ id: user.id })}
                />
              ))}
          </div>
        ),
      }),
    ],
    [currentUserId],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(u) => u.id}
      sortable={['name', 'email', 'createdAt']}
      emptyText="No users match these filters."
      {...paging}
    />
  );
}
