import { describe, expect, it } from 'vitest';
import type { ColumnMappingEntry, ValueMappingEntry } from '../../schemas/import.ts';
import {
  applyDuplicateChecks,
  buildValueMappingLookup,
  collectDistinctValues,
  validateRow,
  type ReferenceData,
} from '../../import/validate/rows.ts';

const columns: ColumnMappingEntry[] = [
  { column: 0, header: 'Client', field: 'client' },
  { column: 1, header: 'Sector', field: 'sector' },
  { column: 2, header: 'Services', field: 'services', separator: ',' },
  { column: 3, header: 'Received', field: 'receivedDate', dateFormat: 'DD/MM/YYYY' },
  { column: 4, header: 'Source', field: 'source' },
  { column: 5, header: 'Owner', field: 'owner' },
];

const refs: ReferenceData = {
  clients: [{ id: 'client-1', name: 'Sun Pharma', sectorId: 'sector-1' }],
  sectors: [{ id: 'sector-1', name: 'Pharmaceutical' }],
  services: [
    { id: 'svc-esg', name: 'ESG' },
    { id: 'svc-hse', name: 'HSE' },
  ],
  owners: [{ id: 'owner-1', name: 'Priya Nair', role: 'SALES' }],
};

const sales = { id: 'owner-1', role: 'SALES' as const, name: 'Priya Nair' };
const admin = { id: 'admin-1', role: 'ADMIN' as const, name: 'Admin User' };

function row(overrides: Record<string, unknown> = {}) {
  return {
    Client: 'Sun Pharma',
    Sector: 'Pharmaceutical',
    Services: 'ESG, HSE',
    Received: '12/03/2025',
    Source: 'Email',
    Owner: '',
    ...overrides,
  };
}

describe('validateRow', () => {
  it('resolves a clean row to READY with all references matched', () => {
    const result = validateRow(row(), columns, new Map(), refs, sales);
    expect(result.status).toBe('READY');
    expect(result.messages).toEqual([]);
    expect(result.resolved).toMatchObject({
      clientId: 'client-1',
      sectorId: 'sector-1',
      serviceIds: expect.arrayContaining(['svc-esg', 'svc-hse']),
      source: 'EMAIL',
      receivedDate: '2025-03-12',
    });
  });

  it('errors when a required field is blank', () => {
    const result = validateRow(row({ Client: '' }), columns, new Map(), refs, sales);
    expect(result.status).toBe('ERROR');
    expect(result.messages).toEqual([
      { field: 'client', code: 'required', message: 'Client is required' },
    ]);
  });

  it('errors when a reference value has no match', () => {
    const result = validateRow(
      row({ Sector: 'Nonexistent Sector' }),
      columns,
      new Map(),
      refs,
      sales,
    );
    expect(result.status).toBe('ERROR');
    expect(result.messages[0]).toMatchObject({ field: 'sector', code: 'unmatched' });
  });

  it('errors on an unparseable date instead of guessing', () => {
    const result = validateRow(row({ Received: 'not a date' }), columns, new Map(), refs, sales);
    expect(result.status).toBe('ERROR');
    expect(result.messages.some((m) => m.field === 'receivedDate')).toBe(true);
  });

  it('requires sourceDetail for sources that need it (shared enquiry rule)', () => {
    const result = validateRow(row({ Source: 'Referral' }), columns, new Map(), refs, sales);
    expect(result.status).toBe('ERROR');
    expect(result.messages.some((m) => m.field === 'sourceDetail')).toBe(true);
  });

  it('a Sales actor can only own their own imported rows', () => {
    const blocked = validateRow(row({ Owner: 'Someone Else' }), columns, new Map(), refs, sales);
    expect(blocked.status).toBe('ERROR');
    expect(blocked.messages[0]).toMatchObject({ field: 'owner', code: 'forbidden' });

    const allowed = validateRow(row({ Owner: 'Priya Nair' }), columns, new Map(), refs, sales);
    expect(allowed.status).toBe('READY');
    expect(allowed.resolved.ownerId).toBe('owner-1');
  });

  it('an Admin actor can set another active user as owner by exact match', () => {
    const result = validateRow(row({ Owner: 'Priya Nair' }), columns, new Map(), refs, admin);
    expect(result.status).toBe('READY');
    expect(result.resolved.ownerId).toBe('owner-1');
  });

  it('uses an explicit Values-step mapping over the live fallback match', () => {
    const mapping: ValueMappingEntry[] = [
      { field: 'sector', sourceValue: 'Pharma', action: 'map', targetId: 'sector-1' },
    ];
    const lookup = buildValueMappingLookup(mapping);
    const result = validateRow(row({ Sector: 'Pharma' }), columns, lookup, refs, sales);
    expect(result.status).toBe('READY');
    expect(result.resolved.sectorId).toBe('sector-1');
  });

  it('flags "create new" for an unmatched client via the Values step', () => {
    const mapping: ValueMappingEntry[] = [
      { field: 'client', sourceValue: 'Brand New Co', action: 'create' },
    ];
    const lookup = buildValueMappingLookup(mapping);
    const result = validateRow(row({ Client: 'Brand New Co' }), columns, lookup, refs, sales);
    expect(result.status).toBe('READY');
    expect(result.resolved.newClientName).toBe('Brand New Co');
    expect(result.resolved.clientId).toBeUndefined();
  });
});

describe('collectDistinctValues', () => {
  it('collects distinct values per reference field, split for multi-value columns', () => {
    const rows = [row(), row({ Client: 'Acme Co', Services: 'ESG' })];
    const distinct = collectDistinctValues(rows, columns);
    const clientField = distinct.find((f) => f.field === 'client')!;
    expect(clientField.values.map((v) => v.value).sort()).toEqual(['Acme Co', 'Sun Pharma']);
    const servicesField = distinct.find((f) => f.field === 'services')!;
    expect(servicesField.values.map((v) => v.value).sort()).toEqual(['ESG', 'HSE']);
  });
});

describe('applyDuplicateChecks', () => {
  const base = validateRow(row(), columns, new Map(), refs, sales);

  it('marks a second matching row in the same file as DUPLICATE', () => {
    const result = applyDuplicateChecks(
      [
        { id: 'r1', result: base },
        { id: 'r2', result: base },
      ],
      new Set(),
    );
    expect(result[0]!.status).toBe('READY');
    expect(result[1]!.status).toBe('DUPLICATE');
  });

  it('marks a row matching an existing DB enquiry as WARNING, not ERROR', () => {
    const result = applyDuplicateChecks(
      [{ id: 'r1', result: base }],
      new Set(['client-1|2025-03-12']),
    );
    expect(result[0]!.status).toBe('WARNING');
  });

  it('leaves ERROR rows alone', () => {
    const errorRow = validateRow(row({ Client: '' }), columns, new Map(), refs, sales);
    const result = applyDuplicateChecks([{ id: 'r1', result: errorRow }], new Set());
    expect(result[0]!.status).toBe('ERROR');
  });
});
