'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/clients', label: 'Clients' },
  { href: '/admin/sectors', label: 'Sectors' },
  { href: '/admin/services', label: 'Services' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/audit-log', label: 'Audit log' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Administration" className="flex flex-wrap gap-1 border-b pb-2">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={pathname.startsWith(link.href) ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm',
            pathname.startsWith(link.href)
              ? 'bg-muted font-medium'
              : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
