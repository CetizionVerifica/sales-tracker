import { can } from '@sales-tracker/core';
import type { ReactNode } from 'react';
import { Forbidden } from '@/components/Forbidden';
import { requireUser } from '@/lib/auth';

/** The admin area is user management and settings: gated on can(user, 'list', 'user'). */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'user')) return <Forbidden />;
  return children;
}
