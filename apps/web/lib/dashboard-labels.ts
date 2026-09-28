import type { AgeingBucket, DashboardDimension, FunnelStage } from '@sales-tracker/core/schemas';

/*
 * Dashboard wording (M12). The definitions are docs/modules/M12-dashboard.md's "Metric
 * definitions", shortened for the ⓘ popovers; keep the two in step.
 */

export const FUNNEL_STAGE_LABELS: Record<FunnelStage, string> = {
  enquiries: 'Enquiries',
  proposalSent: 'Proposal sent',
  quoted: 'Quoted',
  won: 'Won',
  invoiced: 'Invoiced',
  paid: 'Paid',
};

/** Pipeline ramp tokens per funnel stage (UI guide 4.4: the funnel uses the ramp). */
export const FUNNEL_STAGE_COLORS: Record<FunnelStage, string> = {
  enquiries: 'var(--stage-enquiry)',
  proposalSent: 'var(--stage-enquiry)',
  quoted: 'var(--stage-quotation)',
  won: 'var(--stage-project)',
  invoiced: 'var(--stage-po)',
  paid: 'var(--stage-invoice)',
};

export const AGEING_LABELS: Record<AgeingBucket, string> = {
  notDue: 'Not yet due',
  days1to30: '1–30 days',
  days31to60: '31–60 days',
  days61to90: '61–90 days',
  over90: 'Over 90 days',
};

/** Axis ticks for the ageing chart: days past due. */
export const AGEING_SHORT_LABELS: Record<AgeingBucket, string> = {
  notDue: 'Not due',
  days1to30: '1–30',
  days31to60: '31–60',
  days61to90: '61–90',
  over90: '90+',
};

export const DIMENSION_LABELS: Record<DashboardDimension, string> = {
  sector: 'Sector',
  service: 'Service',
  owner: 'Owner',
  source: 'Source',
};

export const DEFINITIONS = {
  openPipeline: 'Quotations sent or under negotiation now, at their INR value. Ignores the period.',
  winRate:
    'Won ÷ (won + lost) among quotations decided in the period: won by the PO received date, lost on the day it was marked lost. Shown when at least 3 were decided.',
  won: 'The quotation amount of quotations whose PO was received in the period.',
  overdue: 'Invoices past their due date and unpaid, now. Ignores the period.',
  funnel:
    'Enquiries received in the period and how far each got: proposal sent, quoted (a live quotation), won (PO received), invoiced, and paid (every invoice under it paid).',
  ageing:
    'Unpaid invoices by days past their due date, as of today. DSO = outstanding ÷ invoiced in the last 90 days × 90.',
  conversion:
    'Win rate on quotations decided in the period, by the quotation’s sector, each of its services, its owner, or its enquiry’s source. “—” under 3 decided.',
  quotedVsWon:
    'Quoted by quotation date and won by PO received date, per month. A period shorter than three months shows the six months ending with it.',
  topClients:
    'Clients by invoiced in the period (invoices include tax). Collected: paid in the period. Outstanding and open pipeline: now.',
  activeProjects: 'Your projects not started, in progress or on hold, now.',
  behindSchedule: 'Active projects past their planned end date, now.',
  invoiced: 'Invoices on your projects dated in the period, at their INR value.',
  projectsByStatus: 'Your projects by status, now.',
  delivered: 'Projects completed in the period: planned end against the day they completed.',
  billing:
    'Active projects and those completed in the period: revenue, and their invoices invoiced, paid and outstanding.',
} as const;
