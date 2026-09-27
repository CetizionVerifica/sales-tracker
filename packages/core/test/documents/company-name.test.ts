import { describe, expect, it } from 'vitest';
import { normaliseCompanyName, sameCompany } from '../../extraction/company-name.ts';

describe('client-name check (AC11)', () => {
  it('matches across case, punctuation and legal suffixes', () => {
    expect(sameCompany('Acme Engineering Pvt. Ltd.', 'ACME Engineering Private Limited')).toBe(
      true,
    );
    expect(sameCompany('M/s. Acme Engineering', 'Acme Engineering Pvt Ltd')).toBe(true);
    expect(sameCompany('The Tata Steel Limited', 'Tata Steel Ltd')).toBe(true);
    expect(sameCompany('Larsen & Toubro Ltd', 'Larsen and Toubro Limited')).toBe(true);
  });

  it('tells different companies apart', () => {
    expect(sameCompany('Globex Ltd', 'ACME Engineering Private Limited')).toBe(false);
    expect(sameCompany('Acme Pharma', 'Acme Engineering')).toBe(false);
    expect(sameCompany('', 'Acme')).toBe(false);
  });

  it('keeps a name that is only a suffix-like word', () => {
    expect(normaliseCompanyName('Limited')).toBe('limited');
  });
});
