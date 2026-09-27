import { can, getCurrentUser } from '@sales-tracker/core';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/SignOutButton';
import { requireUser } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/roles';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUser();
  const me = await getCurrentUser(ctx);

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <nav aria-label="Main" className="flex items-center gap-4 text-sm">
            <Link href="/" className="font-semibold">
              Sales Tracker
            </Link>
            {can(ctx.user, 'list', 'enquiry') && <Link href="/enquiries">Enquiries</Link>}
            {can(ctx.user, 'list', 'user') && <Link href="/admin">Admin</Link>}
            <Link href="/activity">My activity</Link>
            <Link href="/account/password">Change password</Link>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span>{me.name}</span>
            <span className="bg-muted rounded px-2 py-0.5 text-xs">{ROLE_LABELS[me.role]}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4">{children}</main>
    </div>
  );
}
