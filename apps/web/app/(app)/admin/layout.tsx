import { can } from '@sales-tracker/core';
import type { ReactNode } from 'react';
import { NoAccess } from '@/components/feedback/NoAccess';
import { requireUser } from '@/lib/auth';

/**
 * The admin area: gated on can(user, 'list', 'user'); others see No access (UI guide §6).
 * Admin pages are reached from the sidebar's Admin group.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'user')) return <NoAccess />;
  return <>{children}</>;
}
