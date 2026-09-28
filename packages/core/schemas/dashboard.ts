import { z } from 'zod';
import { refinePeriod, reportPeriodShape, type ReportPeriod } from './report.ts';

/*
 * The dashboard (M12). Money is INR paise from each record's stored `amountInrMinor`
 * (Decision 1); rates are ratios in 0–1, not money. Definitions are in
 * docs/modules/M12-dashboard.md ("Metric definitions") and on each query function.
 */

export const DASHBOARD_DIMENSIONS = ['sector', 'service', 'owner', 'source'] as const;
export type DashboardDimension = (typeof DASHBOARD_DIMENSIONS)[number];

export const dashboardInputSchema = z
  .object({
    ...reportPeriodShape,
    /** Admins: narrow to one Sales user's pipeline (personal scope). */
    ownerId: z.string().trim().min(1).optional(),
    /** Admins: one PM's project layout (project scope). */
    managerId: z.string().trim().min(1).optional(),
    dimension: z.enum(DASHBOARD_DIMENSIONS).default('sector'),
  })
  .strict()
  .superRefine(refinePeriod)
  .superRefine((value, context) => {
    if (value.ownerId && value.managerId) {
      context.addIssue({
        code: 'custom',
        path: ['managerId'],
        message: 'Choose an owner or a manager, not both',
      });
    }
  });

export type DashboardInput = z.input<typeof dashboardInputSchema>;

export type DashboardScopeKind = 'company' | 'personal' | 'project';

export interface DashboardScope {
  kind: DashboardScopeKind;
  /** The Sales user (personal) or PM (project) the numbers are for; null for the company. */
  user: { id: string; name: string } | null;
}

/** A count and INR total. */
export interface Tally {
  count: number;
  valueMinor: bigint;
}

export interface WinRate {
  won: number;
  lost: number;
  /** won ÷ (won + lost), or null with fewer than 3 decided (M12: "—"). */
  rate: number | null;
  /** The same by INR value; null when no decided value is known. */
  valueRate: number | null;
}

export interface SalesKpis {
  openPipeline: Tally;
  winRate: WinRate & { previous: number | null };
  won: Tally & { previousMinor: bigint };
  overdue: Tally;
}

export const FUNNEL_STAGES = [
  'enquiries',
  'proposalSent',
  'quoted',
  'won',
  'invoiced',
  'paid',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelRow {
  stage: FunnelStage;
  count: number;
  /** Share of the previous stage (0–1); null for the first stage or after an empty one. */
  conversion: number | null;
  /** Quoted: latest quotation per enquiry; Won: won quotations. Null for other stages. */
  valueMinor: bigint | null;
}

export const AGEING_BUCKETS = [
  'notDue',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export interface Ageing {
  buckets: (Tally & { bucket: AgeingBucket })[];
  total: Tally;
  /** Outstanding ÷ invoiced in the last 90 days × 90, whole days; null with nothing invoiced. */
  dsoDays: number | null;
}

export interface ConversionRow extends WinRate {
  /** The sector, service or owner id, or the enquiry source. */
  key: string;
  label: string;
}

export interface Conversion {
  dimension: DashboardDimension;
  rows: ConversionRow[];
}

export interface MonthRow {
  /** `YYYY-MM`. */
  month: string;
  quotedMinor: bigint;
  wonMinor: bigint;
  lostMinor: bigint;
}

export interface ClientRevenueRow {
  clientId: string;
  name: string;
  invoicedMinor: bigint;
  collectedMinor: bigint;
  outstandingMinor: bigint;
  wonMinor: bigint;
  pipelineMinor: bigint;
}

export interface ProjectKpis {
  activeProjects: number;
  behindSchedule: number;
  invoiced: Tally & { previousMinor: bigint };
  overdue: Tally;
}

export interface DeliveredRow {
  projectId: string;
  label: string;
  client: string;
  endDate: Date | null;
  completedDate: Date;
  /** Positive when late; null without a planned end. */
  daysLate: number | null;
}

export interface BillingRow {
  projectId: string;
  label: string;
  client: string;
  status: string;
  revenueMinor: bigint | null;
  invoicedMinor: bigint;
  paidMinor: bigint;
  outstandingMinor: bigint;
}

/** Records in scope with no INR value yet (no rate for their month). */
export interface MissingFx {
  count: number;
  currencies: string[];
}

interface DashboardBase {
  scope: DashboardScope;
  period: ReportPeriod;
  previous: ReportPeriod;
  missingFx: MissingFx;
}

export interface SalesDashboard extends DashboardBase {
  layout: 'sales';
  kpis: SalesKpis;
  funnel: FunnelRow[];
  ageing: Ageing;
  conversion: Conversion;
  quotedVsWon: MonthRow[];
  topClients: ClientRevenueRow[];
}

export interface ProjectDashboard extends DashboardBase {
  layout: 'project';
  kpis: ProjectKpis;
  projectsByStatus: { status: string; count: number }[];
  ageing: Ageing;
  delivered: DeliveredRow[];
  billing: BillingRow[];
}

export type Dashboard = SalesDashboard | ProjectDashboard;

export const DASHBOARD_PANELS = [
  'funnel',
  'ageing',
  'conversion',
  'quotedVsWon',
  'topClients',
  'projectsByStatus',
  'delivered',
  'billing',
] as const;
export type DashboardPanel = (typeof DASHBOARD_PANELS)[number];

export const dashboardExportSchema = z.enum(DASHBOARD_PANELS);

/** Rows for a CSV: money as rupees with two decimals, never abbreviated. */
export interface PanelExport {
  filename: string;
  columns: string[];
  rows: string[][];
}
