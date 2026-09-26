import { can } from '@sales-tracker/core';
import type { ReactNode } from 'react';
import { AdminNav } from '@/components/admin/AdminNav';
import { Forbidden } from '@/components/Forbidden';
import { requireUser } from '@/lib/auth';

/** The admin area: gated on can(user, 'list', 'user'); non-admins see the Forbidden page. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'user')) return <Forbidden />;
  return (
    <div className="flex flex-col gap-6 py-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Administration</h1>
        <AdminNav />
      </div>
      {children}
    </div>
  );
}
