import type { StageId } from '@/components/pipeline/PipelineStrip';

/** Serialisable nav data, built on the server from can() (UI guide: hide what users can't use). */
export type NavIcon =
  | 'today'
  | 'enquiries'
  | 'quotations'
  | 'projects'
  | 'purchaseOrders'
  | 'invoices'
  | 'clients'
  | 'users'
  | 'sectors'
  | 'services'
  | 'settings'
  | 'audit';

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Pipeline items carry their stage colour as the active bar. */
  stage?: StageId;
  /** Matched exactly rather than by prefix. */
  exact?: boolean;
  /** An attention count (My today: overdue and due today); hidden when 0 or absent. */
  badge?: number;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export interface NewMenuItem {
  href: string;
  label: string;
}

export interface ShellUser {
  name: string;
  email: string;
  roleLabel: string;
}
