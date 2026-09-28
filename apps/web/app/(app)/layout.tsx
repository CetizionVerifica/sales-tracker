import { can, getCurrentUser } from '@sales-tracker/core';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import type { PaletteAction } from '@/components/layout/CommandPalette';
import type { NavGroup, NewMenuItem } from '@/components/layout/nav';
import { requireUser } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/roles';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUser();
  const me = await getCurrentUser(ctx);
  const user = ctx.user;
  const isAdmin = can(user, 'list', 'user');

  // Only modules that exist, and only what the role can use (UI guide §3). My today,
  // Dashboard, Invoices and MCP access join as M10–M13 ship.
  const projects = can(user, 'list', 'project')
    ? [{ href: '/projects', label: 'Projects', icon: 'projects', stage: 'project' } as const]
    : [];
  const purchaseOrders = can(user, 'list', 'purchaseOrder')
    ? [
        {
          href: '/purchase-orders',
          label: 'Purchase orders',
          icon: 'purchaseOrders',
          stage: 'po',
        } as const,
      ]
    : [];
  const groups: NavGroup[] = [
    { items: [{ href: '/', label: 'Home', icon: 'home', exact: true }] },
    {
      label: 'Pipeline',
      items: [
        // Projects lead for project managers, whose work starts there (M8).
        ...(user.role === 'PROJECT_MANAGER' ? [...projects, ...purchaseOrders] : []),
        ...(can(user, 'list', 'enquiry')
          ? [
              {
                href: '/enquiries',
                label: 'Enquiries',
                icon: 'enquiries',
                stage: 'enquiry',
              } as const,
            ]
          : []),
        ...(can(user, 'list', 'quotation')
          ? [
              {
                href: '/quotations',
                label: 'Quotations',
                icon: 'quotations',
                stage: 'quotation',
              } as const,
            ]
          : []),
        ...(user.role === 'PROJECT_MANAGER' ? [] : [...projects, ...purchaseOrders]),
        ...(can(user, 'list', 'client')
          ? [{ href: '/clients', label: 'Clients', icon: 'clients' } as const]
          : []),
      ],
    },
    ...(isAdmin
      ? [
          {
            label: 'Admin',
            items: [
              { href: '/admin/users', label: 'Users', icon: 'users' },
              { href: '/admin/clients', label: 'Client records', icon: 'clients' },
              { href: '/admin/sectors', label: 'Sectors', icon: 'sectors' },
              { href: '/admin/services', label: 'Services', icon: 'services' },
              { href: '/admin/settings', label: 'Settings', icon: 'settings' },
              { href: '/admin/audit-log', label: 'Audit log', icon: 'audit' },
            ],
          } satisfies NavGroup,
        ]
      : []),
  ];

  // + New: records that start on their own. Quotations start from a converted enquiry
  // (M6 Decision 1) and follow-ups from a record, so they are not here. A project starts
  // from a quotation with a PO received (M8 Decision 1): the item opens those still waiting.
  const newItems: NewMenuItem[] = [
    ...(can(user, 'create', 'enquiry') ? [{ href: '/enquiries/new', label: 'Enquiry' }] : []),
    ...(can(user, 'create', 'project')
      ? [{ href: '/quotations?status=PO_RECEIVED&hasProject=false', label: 'Project' }]
      : []),
    // A PO is recorded on a project; the page starts with a project picker (M9).
    ...(can(user, 'create', 'purchaseOrder')
      ? [{ href: '/purchase-orders/new', label: 'PO' }]
      : []),
    ...(isAdmin ? [{ href: '/admin/clients/new', label: 'Client' }] : []),
  ];

  const actions: PaletteAction[] = [
    ...newItems.map((item) => ({ label: `New ${item.label.toLowerCase()}`, href: item.href })),
    { label: 'Change password', href: '/account/password' },
    { label: 'My activity', href: '/activity' },
  ];

  return (
    <AppShell
      user={{ name: me.name, email: me.email, roleLabel: ROLE_LABELS[me.role] }}
      groups={groups}
      newItems={newItems}
      actions={actions}
    >
      {children}
    </AppShell>
  );
}
