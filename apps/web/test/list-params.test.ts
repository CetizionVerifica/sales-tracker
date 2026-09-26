import { listParamsSchema } from '@sales-tracker/core/schemas';
import { describe, expect, it } from 'vitest';
import { parseListParams, toSearch } from '../lib/list-params.ts';

describe('parseListParams (URL search params → list input)', () => {
  it('applies defaults', () => {
    expect(parseListParams({}, listParamsSchema)).toEqual({ page: 1, pageSize: 25 });
  });

  it('reads page, size, search and sort, taking the first of repeated params', () => {
    expect(
      parseListParams(
        { page: '3', pageSize: '10', q: ' pharma ', sort: 'name', dir: 'desc', extra: 'x' },
        listParamsSchema,
      ),
    ).toEqual({ page: 3, pageSize: 10, q: 'pharma', sort: 'name', dir: 'desc' });
    expect(parseListParams({ page: ['2', '9'] }, listParamsSchema)).toMatchObject({ page: 2 });
  });

  it('falls back to defaults on invalid values instead of crashing the page', () => {
    expect(
      parseListParams({ page: '-4', pageSize: '100000', dir: 'sideways' }, listParamsSchema),
    ).toEqual({
      page: 1,
      pageSize: 25,
    });
  });

  it('builds a query string, dropping empty values', () => {
    expect(toSearch({ page: 2, q: '', sort: 'name', dir: undefined })).toBe('?page=2&sort=name');
  });
});
