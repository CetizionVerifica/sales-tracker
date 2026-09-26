import { describe, expect, it } from 'vitest';
import { safeNext } from '../lib/safe-next.ts';

describe('safeNext (post-login redirect guard)', () => {
  it.each(['/', '/admin', '/enquiries?status=open'])('keeps the same-site path %s', (path) => {
    expect(safeNext(path)).toBe(path);
  });

  it.each([
    ['protocol-relative URL', '//evil.example'],
    ['backslash trick', '/\\evil.example'],
    ['absolute URL', 'https://evil.example/phish'],
    ['javascript URL', 'javascript:alert(1)'],
    ['relative path without slash', 'admin'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('falls back to / for a %s', (_label, value) => {
    expect(safeNext(value)).toBe('/');
  });
});
