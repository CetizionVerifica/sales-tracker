import { listUsers } from '@sales-tracker/core';
import { listUsersSchema } from '@sales-tracker/core/schemas';
import { ListToolbar } from '@/components/data-table/ListToolbar';
import { requireUser } from '@/lib/auth';
import { parseListParams, type SearchParams } from '@/lib/list-params';
import { UserDialog } from './UserDialog';
import { UsersTable } from './UsersTable';

export const metadata = { title: 'Users · Sales Tracker' };

export default async function UsersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireUser();
  const params = parseListParams(await searchParams, listUsersSchema);
  const result = await listUsers(ctx, params);

  return (
    <section className="flex flex-col gap-4">
      <ListToolbar
        searchPlaceholder="Search name or email"
        filters={[
          {
            param: 'role',
            label: 'Roles',
            options: [
              { value: 'ADMIN', label: 'Admin' },
              { value: 'SALES', label: 'Sales' },
              { value: 'PROJECT_MANAGER', label: 'Project manager' },
            ],
          },
          {
            param: 'status',
            label: 'Statuses',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ],
          },
        ]}
      >
        <UserDialog mode="create" />
      </ListToolbar>
      <UsersTable
        currentUserId={ctx.user.id}
        rows={result.items.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }))}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        sort={params.sort}
        dir={params.dir}
      />
    </section>
  );
}
