import { describe, expect, it } from 'vitest';
import { matchesMimeType } from '../../storage/magic-bytes.ts';
import { samplePdf, samplePng, sampleJpeg, sampleWebp } from './files.ts';

describe('magic bytes (AC2)', () => {
  it('accepts each supported type with its own signature', () => {
    expect(matchesMimeType(samplePdf('x'), 'application/pdf')).toBe(true);
    expect(matchesMimeType(samplePng(), 'image/png')).toBe(true);
    expect(matchesMimeType(sampleJpeg(), 'image/jpeg')).toBe(true);
    expect(matchesMimeType(sampleWebp(), 'image/webp')).toBe(true);
  });

  it('rejects a renamed file', () => {
    expect(matchesMimeType(samplePng(), 'application/pdf')).toBe(false);
    expect(matchesMimeType(samplePdf('x'), 'image/png')).toBe(false);
    expect(matchesMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46]), 'image/webp')).toBe(false);
    expect(matchesMimeType(new Uint8Array(), 'image/jpeg')).toBe(false);
  });
});
