import { describe, expect, it } from 'vitest';
import { exactMatch } from '../../import/resolve/match.ts';

describe('exactMatch', () => {
  const options = [
    { id: '1', name: 'Sun Pharmaceutical Industries Ltd' },
    { id: '2', name: 'Acme Co' },
  ];

  it('matches case-insensitively', () => {
    expect(exactMatch('SUN PHARMACEUTICAL INDUSTRIES LTD', options)).toEqual(options[0]);
  });

  it('matches with surrounding whitespace ignored', () => {
    expect(exactMatch('  Acme Co  ', options)).toEqual(options[1]);
  });

  it('returns null when nothing matches', () => {
    expect(exactMatch('Sun Pharma', options)).toBeNull();
  });

  it('returns null for a blank value', () => {
    expect(exactMatch('   ', options)).toBeNull();
  });
});
