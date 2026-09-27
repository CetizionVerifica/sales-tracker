import { describe, expect, it } from 'vitest';
import { reviewExtractionFormSchema } from '../../schemas/document.ts';

const rows = [
  { name: 'quotationDate', applies: ['quotationDate'] },
  { name: 'amount', applies: ['amount', 'currency'] },
  { name: 'description', applies: ['description'] },
];
const schema = reviewExtractionFormSchema('QUOTATION', rows);
const form = (ticked: Record<string, boolean>, values: Record<string, string> = {}) => ({
  ticked,
  values: {
    quotationDate: '2026-03-11',
    amount: '1,25,000.50',
    currency: 'INR',
    description: 'Scope',
    ...values,
  },
});
const errorPaths = (input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

describe('review form schema (shared with zodResolver)', () => {
  it('accepts valid ticked values and nothing ticked', () => {
    expect(errorPaths(form({ amount: true, quotationDate: true, description: true }))).toEqual([]);
    expect(errorPaths(form({}))).toEqual([]);
  });

  it('checks ticked values with the quotation form schema, on the value’s own field', () => {
    expect(errorPaths(form({ amount: true }, { amount: '10.123' }))).toEqual(['values.amount']);
    expect(errorPaths(form({ quotationDate: true }, { quotationDate: '2099-01-01' }))).toEqual([
      'values.quotationDate',
    ]);
    expect(errorPaths(form({ amount: true }, { currency: 'XXQ' }))).toContain('values.currency');
  });

  it('ignores invalid values on unticked rows', () => {
    expect(errorPaths(form({ description: true }, { amount: 'nonsense' }))).toEqual([]);
  });
});
