import type { Dashboard, DashboardPanel, PanelExport } from '../../schemas/dashboard.ts';
import { DomainError } from '../../errors.ts';
import { toCalendarDateString } from '../../schemas/common.ts';
import { toAmountString } from '../../schemas/money.ts';
import { PROJECT_STATUS_LABELS } from '../../status/project.ts';

/** Exports show statuses as people read them, never the enum. */
const statusLabel = (status: string) =>
  PROJECT_STATUS_LABELS[status as keyof typeof PROJECT_STATUS_LABELS] ?? status;

/*
 * One panel's data as CSV rows (M12 AC11): money as plain rupees with two decimals, never
 * abbreviated; rates as percentages with one decimal; dates as YYYY-MM-DD.
 */

const rupees = (paise: bigint | null) => (paise === null ? '' : toAmountString(paise, 'INR'));
const percent = (rate: number | null) => (rate === null ? '' : (rate * 100).toFixed(1));
const date = (value: Date | null) => (value ? toCalendarDateString(value) : '');

const AGEING_LABELS = {
  notDue: 'Not yet due',
  days1to30: '1–30 days overdue',
  days31to60: '31–60 days overdue',
  days61to90: '61–90 days overdue',
  over90: 'Over 90 days overdue',
} as const;

const FUNNEL_LABELS = {
  enquiries: 'Enquiries',
  proposalSent: 'Proposal sent',
  quoted: 'Quoted',
  won: 'Won',
  invoiced: 'Invoiced',
  paid: 'Paid',
} as const;

const kebab = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
const slug = (text: string) =>
  text
    .replace(/[–—]/g, '-')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

function rowsFor(dashboard: Dashboard, panel: DashboardPanel): Omit<PanelExport, 'filename'> {
  if (dashboard.layout === 'sales') {
    switch (panel) {
      case 'funnel':
        return {
          columns: ['Stage', 'Enquiries', 'Conversion from previous stage (%)', 'Value (INR)'],
          rows: dashboard.funnel.map((r) => [
            FUNNEL_LABELS[r.stage],
            String(r.count),
            percent(r.conversion),
            rupees(r.valueMinor),
          ]),
        };
      case 'ageing':
        break; // shared below
      case 'conversion':
        return {
          columns: ['Group', 'Won', 'Lost', 'Win rate (%)'],
          rows: dashboard.conversion.rows.map((r) => [
            r.label,
            String(r.won),
            String(r.lost),
            percent(r.rate),
          ]),
        };
      case 'quotedVsWon':
        return {
          columns: ['Month', 'Quoted (INR)', 'Won (INR)', 'Lost (INR)'],
          rows: dashboard.quotedVsWon.map((m) => [
            m.month,
            rupees(m.quotedMinor),
            rupees(m.wonMinor),
            rupees(m.lostMinor),
          ]),
        };
      case 'topClients':
        return {
          columns: [
            'Client',
            'Invoiced (INR, incl. tax)',
            'Collected (INR)',
            'Outstanding now (INR)',
            'Won (INR)',
            'Open pipeline now (INR)',
          ],
          rows: dashboard.topClients.map((c) => [
            c.name,
            rupees(c.invoicedMinor),
            rupees(c.collectedMinor),
            rupees(c.outstandingMinor),
            rupees(c.wonMinor),
            rupees(c.pipelineMinor),
          ]),
        };
      default:
        throw new DomainError('That panel is on the project dashboard');
    }
  } else {
    switch (panel) {
      case 'ageing':
        break;
      case 'projectsByStatus':
        return {
          columns: ['Status', 'Projects'],
          rows: dashboard.projectsByStatus.map((r) => [statusLabel(r.status), String(r.count)]),
        };
      case 'delivered':
        return {
          columns: ['Project', 'Client', 'Planned end', 'Completed', 'Days late'],
          rows: dashboard.delivered.map((r) => [
            r.label,
            r.client,
            date(r.endDate),
            date(r.completedDate),
            r.daysLate === null ? '' : String(r.daysLate),
          ]),
        };
      case 'billing':
        return {
          columns: [
            'Project',
            'Client',
            'Status',
            'Revenue (INR)',
            'Invoiced (INR)',
            'Paid (INR)',
            'Outstanding (INR)',
          ],
          rows: dashboard.billing.map((r) => [
            r.label,
            r.client,
            statusLabel(r.status),
            rupees(r.revenueMinor),
            rupees(r.invoicedMinor),
            rupees(r.paidMinor),
            rupees(r.outstandingMinor),
          ]),
        };
      default:
        throw new DomainError('That panel is on the sales dashboard');
    }
  }
  return {
    columns: ['Bucket', 'Invoices', 'Outstanding (INR)'],
    rows: [
      ...dashboard.ageing.buckets.map((b) => [
        AGEING_LABELS[b.bucket],
        String(b.count),
        rupees(b.valueMinor),
      ]),
      ['Total', String(dashboard.ageing.total.count), rupees(dashboard.ageing.total.valueMinor)],
    ],
  };
}

export function panelExport(dashboard: Dashboard, panel: DashboardPanel): PanelExport {
  return {
    filename: `dashboard-${kebab(panel)}-${slug(dashboard.period.label)}.csv`,
    ...rowsFor(dashboard, panel),
  };
}

/** Formula characters Excel and Sheets would execute at the start of a cell (OWASP). */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One CSV field. Text that starts like a formula gets a leading apostrophe, so a client
 * named "=HYPERLINK(…)" stays text when the file is opened (CSV injection); plain numbers,
 * including a negative "days late", are left as numbers.
 */
const cell = (raw: string) => {
  const value = FORMULA_START.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
};

/** RFC 4180 CSV with a UTF-8 BOM, so Excel shows ₹ and accented names correctly. */
export function toCsv({ columns, rows }: Pick<PanelExport, 'columns' | 'rows'>): string {
  return `\uFEFF${[columns, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
