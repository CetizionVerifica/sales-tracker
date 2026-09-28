import { toCalendarDateString } from '../schemas/common.ts';
import { toAmountString } from '../schemas/money.ts';
import type { SalesReport } from './index.ts';

/*
 * One CSV per report (R1–R6), the data behind its chart plus the definition as a comment line
 * (M12b: "Export CSV"). Money as plain rupees with two decimals, never abbreviated, as the
 * M12 dashboard's exports (CLAUDE.md conventions carried over).
 */

export const REPORT_EXPORT_KEYS = [
  'enquiryVolume',
  'enquiryStatus',
  'sectorPos',
  'serviceSales',
  'customerMix',
  'revenue',
] as const;
export type ReportExportKey = (typeof REPORT_EXPORT_KEYS)[number];

export interface ReportCsv {
  filename: string;
  body: string;
}

const rupees = (paise: bigint) => toAmountString(paise, 'INR');
const percent = (n: number | null) => (n === null ? '' : n.toFixed(0));

const slug = (text: string) =>
  text
    .replace(/[–—]/g, '-')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

/** Formula characters Excel/Sheets would execute at the start of a cell (OWASP: CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

const cell = (raw: string) => {
  const value = FORMULA_START.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
};

/** A UTF-8 BOM, so Excel shows ₹ and accented names correctly. */
const BOM = String.fromCharCode(0xfeff);

function toReportCsv(definition: string, columns: string[], rows: string[][]): string {
  const lines = [[`Definition: ${definition}`], [], columns, ...rows];
  return `${BOM}${lines.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

function rowsFor(
  report: SalesReport,
  key: ReportExportKey,
): { columns: string[]; rows: string[][]; definition: string } {
  switch (key) {
    case 'enquiryVolume': {
      const r = report.enquiryVolume;
      return {
        columns: ['Bucket start', 'Enquiries'],
        rows: r.data.map((b) => [b.bucket, String(b.count)]),
        definition: r.definition,
      };
    }
    case 'enquiryStatus': {
      const r = report.enquiryStatus;
      return {
        columns: ['Bucket', 'Count', 'Share (%)'],
        rows: r.buckets.map((b) => [b.bucket, String(b.count), percent(b.pct)]),
        definition: r.definition,
      };
    }
    case 'sectorPos': {
      const r = report.sectorPos;
      return {
        columns: ['Sector', 'POs', 'Value (INR)', 'Share (%)'],
        rows: r.data.map((row) => [
          row.name,
          String(row.count),
          rupees(row.valueMinor),
          percent(row.sharePct),
        ]),
        definition: r.definition,
      };
    }
    case 'serviceSales': {
      const r = report.serviceSales;
      return {
        columns: ['Service', 'Value (INR)', 'POs', 'Share (%)'],
        rows: r.data.map((row) => [
          row.name,
          rupees(row.valueMinor),
          String(row.poCount),
          percent(row.sharePct),
        ]),
        definition:
          r.definition +
          (r.estimated ? ' Some multi-service POs use an estimated equal split.' : ''),
      };
    }
    case 'customerMix': {
      const r = report.customerMix;
      return {
        columns: ['Month', 'First orders', 'Repeat orders', 'Repeat order value (INR)'],
        rows: r.months.map((m) => [
          m.month,
          String(m.firstOrders),
          String(m.repeatOrders),
          rupees(m.repeatValueMinor),
        ]),
        definition: r.definition,
      };
    }
    case 'revenue': {
      const r = report.revenue;
      return {
        columns: [
          'Month',
          'Invoices',
          'Invoiced (INR)',
          'Collected (INR)',
          'Outstanding at month end (INR)',
          'PO booked (INR)',
          'Top client by invoiced value',
        ],
        rows: r.months.map((m) => [
          m.month,
          String(m.invoiceCount),
          rupees(m.invoicedMinor),
          rupees(m.collectedMinor),
          rupees(m.outstandingMinor),
          rupees(m.poBookedMinor),
          m.topClient ?? '',
        ]),
        definition: r.definition,
      };
    }
  }
}

export function reportCsv(report: SalesReport, key: ReportExportKey): ReportCsv {
  const { columns, rows, definition } = rowsFor(report, key);
  const generated = toCalendarDateString(new Date());
  return {
    filename: `report-${slug(key)}-${slug(report.period.label)}-${generated}.csv`,
    body: toReportCsv(definition, columns, rows),
  };
}
