'use client';

import {
  ArrowLeftRight,
  Briefcase,
  Building2,
  ClipboardList,
  FileCheck,
  FileText,
  ListChecks,
  Inbox,
  Layers,
  LayoutDashboard,
  Receipt,
  ScrollText,
  Settings,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import type { NavGroup, NavIcon } from './nav';

const ICONS: Record<NavIcon, LucideIcon> = {
  today: ListChecks,
  dashboard: LayoutDashboard,
  rates: ArrowLeftRight,
  enquiries: Inbox,
  quotations: FileText,
  projects: Briefcase,
  purchaseOrders: FileCheck,
  invoices: Receipt,
  clients: Building2,
  users: Users,
  sectors: Layers,
  services: Wrench,
  settings: Settings,
  audit: ScrollText,
};

const STAGE_BAR = {
  enquiry: 'before:bg-stage-enquiry',
  quotation: 'before:bg-stage-quotation',
  project: 'before:bg-stage-project',
  po: 'before:bg-stage-po',
  invoice: 'before:bg-stage-invoice',
} as const;

/**
 * The 240px sidebar (UI guide §3): collapses to 64px icons, off-canvas below 1024px.
 * Pipeline items show a 3px bar in their stage colour when active.
 */
export function AppSidebar({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center border-b">
        <Link
          href="/today"
          className="flex items-center gap-2 px-2 font-semibold"
          onClick={() => setOpenMobile(false)}
        >
          <ClipboardList
            className="text-primary size-[18px] shrink-0"
            strokeWidth={1.75}
            aria-hidden
          />
          <span className="truncate group-data-[collapsible=icon]:hidden">Sales Tracker</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main" className="contents">
          {groups.map((group, index) => (
            <SidebarGroup key={group.label ?? index}>
              {group.label && (
                <SidebarGroupLabel className="text-muted-foreground text-xs font-medium">
                  {group.label}
                </SidebarGroupLabel>
              )}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const Icon = ICONS[item.icon];
                    const active = isActive(item.href, item.exact);
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          tooltip={item.label}
                          className={cn(
                            'relative',
                            item.stage &&
                              active &&
                              cn(
                                'before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full',
                                STAGE_BAR[item.stage],
                              ),
                          )}
                        >
                          <Link href={item.href} onClick={() => setOpenMobile(false)}>
                            <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                        {item.badge ? (
                          <SidebarMenuBadge
                            className="bg-attention-soft text-attention-foreground num rounded-[var(--radius-control)]"
                            aria-label={`${item.badge} due`}
                          >
                            {item.badge}
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}
