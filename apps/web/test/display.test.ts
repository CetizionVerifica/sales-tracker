import { describe, expect, it } from 'vitest';
import { initials, relativeDue } from '../lib/display.ts';
import { statusStyle } from '../lib/status-styles.ts';

describe('relativeDue (guide §5 dates)', () => {
  const today = '2026-10-07';
  it('says today, overdue and upcoming in words', () => {
    expect(relativeDue('2026-10-07', today)).toEqual({ text: 'Due today', attention: true });
    expect(relativeDue('2026-10-04', today)).toEqual({ text: '3 days overdue', attention: true });
    expect(relativeDue('2026-10-06', today)).toEqual({ text: '1 day overdue', attention: true });
    expect(relativeDue('2026-10-08', today)).toEqual({ text: 'Tomorrow', attention: false });
    expect(relativeDue('2026-10-09', today)).toEqual({ text: 'In 2 days', attention: false });
  });

  it('accepts Date values stored as UTC midnight', () => {
    expect(relativeDue(new Date('2026-10-05T00:00:00Z'), today).text).toBe('2 days overdue');
  });
});

describe('status badge styles (guide §5 table)', () => {
  it.each([
    ['enquiry', 'IN_PROGRESS', 'neutral', 'In progress'],
    ['enquiry', 'CONVERTED', 'success', 'Converted'],
    ['enquiry', 'LOST', 'destructive', 'Lost'],
    ['quotation', 'SENT', 'neutral', 'Sent'],
    ['quotation', 'UNDER_NEGOTIATION', 'warning', 'Under negotiation'],
    ['quotation', 'PO_RECEIVED', 'success', 'PO received'],
    ['quotation', 'LOST', 'destructive', 'Lost'],
    ['invoice', 'OVERDUE', 'attention', 'Overdue'],
    ['po', 'PAID', 'success', 'Paid'],
  ] as const)('%s %s is %s, labelled "%s"', (entity, status, tone, label) => {
    expect(statusStyle(entity, status)).toEqual({ tone, label });
  });

  it('never shows an enum string for an unknown status', () => {
    expect(statusStyle('quotation', 'SOMETHING_NEW').label).toBe('Something new');
  });
});

describe('initials', () => {
  it('takes the first letters of the first and last names', () => {
    expect(initials('Sam Sales')).toBe('SS');
    expect(initials('madonna')).toBe('M');
    expect(initials('  Anita  Rao Kulkarni ')).toBe('AK');
  });
});

describe('pagination window', async () => {
  const { pageWindow } = await import('../lib/pagination.ts');
  it('shows first, last and neighbours with gaps', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(5, 10)).toEqual([1, 'gap', 4, 5, 6, 'gap', 10]);
    expect(pageWindow(10, 10)).toEqual([1, 'gap', 9, 10]);
  });
});

describe('audit wording', async () => {
  const { humanize, AUDIT_ACTION_LABELS } = await import('../lib/audit-labels.ts');
  it('turns model and field names into words', () => {
    expect(humanize('QuotationService')).toBe('Quotation service');
    expect(humanize('amountMinor')).toBe('Amount minor');
    expect(humanize('CompanySettings')).toBe('Company settings');
    expect(AUDIT_ACTION_LABELS.SOFT_DELETE).toBe('Deleted');
  });
});
