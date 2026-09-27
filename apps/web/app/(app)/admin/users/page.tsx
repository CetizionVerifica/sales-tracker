import { listUsers } from '@sales-tracker/core';
import { listUsersSchema } from '@sales-tracker/core/schemas';
import { FilterBar } from '@/components/data/FilterBar';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireAdmin } from '@/lib/auth';
import { filterKeys, parseListParams, type SearchParams } from '@/lib/list-params';
import { NewUserButton } from './UserSheet';
import { UsersTable } from './UsersTable';

export const metadata = { title: 'Users · Sales Tracker' };

export default async function UsersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows No access
  const raw = await searchParams;
  const params = parseListParams(raw, listUsersSchema);
  const result = await listUsers(ctx, params);

  return (
    <>
      <PageHeader
        title="Users"
        description="Who can sign in, and what each role can do"
        actions={<NewUserButton />}
      />
      <FilterBar
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
      />
      <UsersTable
        currentUserId={ctx.user.id}
        rows={result.items.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }))}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        sort={params.sort}
        dir={params.dir}
        filtered={filterKeys(raw).length > 0}
      />
    </>
  );
}
