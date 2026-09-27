import type { ReactNode } from 'react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './AppSidebar';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import type { NavGroup, NewMenuItem, ShellUser } from './nav';
import { TopBar } from './TopBar';

/**
 * The one app shell (UI guide §3): sidebar, 56px top bar, and page content with 24px
 * padding (16px on mobile). Content width is set by the page (none for tables and
 * dashboards; 880px for forms and settings).
 */
export function AppShell({
  user,
  groups,
  newItems,
  actions,
  children,
}: {
  user: ShellUser;
  groups: NavGroup[];
  newItems: NewMenuItem[];
  actions: PaletteAction[];
  children: ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar groups={groups} />
      <SidebarInset className="bg-background min-w-0">
        <TopBar user={user} newItems={newItems} />
        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">{children}</main>
      </SidebarInset>
      <CommandPalette groups={groups} actions={actions} />
    </SidebarProvider>
  );
}
