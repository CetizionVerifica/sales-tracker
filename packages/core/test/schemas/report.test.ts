import { describe, expect, it } from 'vitest';
import {
  chartMonths,
  fyLabel,
  monthsIn,
  previousPeriod,
  reportPeriodSchema,
  resolvePeriod,
} from '../../schemas/report.ts';

// M12 AC3 (unit): report periods on the Indian financial year (Decision 3).

const d = (day: string) => new Date(`${day}T00:00:00.000Z`);
const ymd = (date: Date) => date.toISOString().slice(0, 10);
const span = (p: { from: Date; to: Date }) => [ymd(p.from), ymd(p.to)];
const resolve = (preset: string, today: string, extra = {}) =>
  resolvePeriod(reportPeriodSchema.parse({ preset, ...extra }), d(today));

describe('resolvePeriod', () => {
  it.each([
    // [today, thisQuarter, label]
    ['2026-04-01', ['2026-04-01', '2026-06-30'], 'Q1 FY 2026–27'],
    ['2026-06-30', ['2026-04-01', '2026-06-30'], 'Q1 FY 2026–27'],
    ['2026-09-28', ['2026-07-01', '2026-09-30'], 'Q2 FY 2026–27'],
    ['2026-11-15', ['2026-10-01', '2026-12-31'], 'Q3 FY 2026–27'],
    ['2027-03-31', ['2027-01-01', '2027-03-31'], 'Q4 FY 2026–27'],
  ])('this quarter on %s', (today, expected, label) => {
    const period = resolve('thisQuarter', today);
    expect(span(period)).toEqual(expected);
    expect(period.label).toBe(label);
  });

  it('crosses the financial year on 31 March / 1 April', () => {
    expect(span(resolve('thisFinancialYear', '2027-03-31'))).toEqual(['2026-04-01', '2027-03-31']);
    expect(span(resolve('thisFinancialYear', '2027-04-01'))).toEqual(['2027-04-01', '2028-03-31']);
    expect(span(resolve('lastFinancialYear', '2027-04-01'))).toEqual(['2026-04-01', '2027-03-31']);
    expect(resolve('lastFinancialYear', '2027-04-01').label).toBe('FY 2026–27');
    expect(span(resolve('lastQuarter', '2026-04-10'))).toEqual(['2026-01-01', '2026-03-31']);
    expect(resolve('lastQuarter', '2026-04-10').label).toBe('Q4 FY 2025–26');
  });

  it('months, including February in a leap year', () => {
    expect(span(resolve('thisMonth', '2028-02-10'))).toEqual(['2028-02-01', '2028-02-29']);
    expect(span(resolve('lastMonth', '2026-01-05'))).toEqual(['2025-12-01', '2025-12-31']);
    expect(resolve('thisMonth', '2026-09-28').label).toBe('September 2026');
  });

  it('a custom range keeps its dates', () => {
    const period = resolve('custom', '2026-09-28', { from: '2026-08-17', to: '2026-09-30' });
    expect(span(period)).toEqual(['2026-08-17', '2026-09-30']);
    expect(period.label).toBe('17 Aug – 30 Sept 2026');
  });

  it('defaults to this quarter', () => {
    expect(reportPeriodSchema.parse({}).preset).toBe('thisQuarter');
  });
});

describe('reportPeriodSchema refuses', () => {
  it.each([
    ['custom without dates', { preset: 'custom' }],
    ['from after to', { preset: 'custom', from: '2026-09-30', to: '2026-09-01' }],
    ['more than three years', { preset: 'custom', from: '2022-01-01', to: '2026-01-01' }],
    ['an unknown preset', { preset: 'thisDecade' }],
  ])('%s', (_label, input) => {
    expect(reportPeriodSchema.safeParse(input).success).toBe(false);
  });
});

describe('previousPeriod', () => {
  it('a preset compares with the previous unit', () => {
    expect(span(previousPeriod(resolve('thisQuarter', '2026-09-28')))).toEqual([
      '2026-04-01',
      '2026-06-30',
    ]);
    expect(span(previousPeriod(resolve('thisMonth', '2026-03-15')))).toEqual([
      '2026-02-01',
      '2026-02-28',
    ]);
    expect(span(previousPeriod(resolve('thisFinancialYear', '2026-09-28')))).toEqual([
      '2025-04-01',
      '2026-03-31',
    ]);
  });

  it('a custom range compares with the same number of days before it', () => {
    const custom = resolve('custom', '2026-09-28', { from: '2026-08-17', to: '2026-09-30' });
    expect(span(previousPeriod(custom))).toEqual(['2026-07-03', '2026-08-16']);
  });
});

describe('months', () => {
  it('lists each month the period touches', () => {
    expect(monthsIn(resolve('thisQuarter', '2026-09-28')).map(ymd)).toEqual([
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);
  });

  it('charts at least six months: a short period shows the six ending with it', () => {
    expect(chartMonths(resolve('thisMonth', '2026-09-28')).map(ymd)).toEqual([
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);
    expect(chartMonths(resolve('thisFinancialYear', '2026-09-28'))).toHaveLength(12);
  });

  it('fyLabel', () => {
    expect(fyLabel(d('2026-03-31'))).toBe('FY 2025–26');
    expect(fyLabel(d('2026-04-01'))).toBe('FY 2026–27');
  });
});
