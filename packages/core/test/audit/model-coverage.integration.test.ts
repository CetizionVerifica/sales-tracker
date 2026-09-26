import { Prisma } from '@sales-tracker/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_EXCLUDED, auditedModels, modelFields } from '../../audit/model-meta.ts';
import { disconnectAll, getDb } from '../../clients.ts';

// AC13: every model is either audited (and has the single `id` the extension relies on)
// or excluded with a written reason. A new model is audited by default.
describe('AC13: audit coverage of every Prisma model', () => {
  beforeAll(() => {
    getDb(); // creating the client registers the model metadata
  });
  afterAll(disconnectAll);

  it('reads model metadata from the client (fails loudly if Prisma internals change)', () => {
    expect(Object.keys(modelFields()).sort()).toEqual(Object.values(Prisma.ModelName).sort());
  });

  it.each(Object.values(Prisma.ModelName))('%s is audited or explicitly excluded', (model) => {
    const excluded = AUDIT_EXCLUDED[model as keyof typeof AUDIT_EXCLUDED];
    if (excluded) {
      expect(excluded.length).toBeGreaterThan(10); // a real reason, not a placeholder
      expect(auditedModels()).not.toContain(model);
    } else {
      expect(auditedModels()).toContain(model);
      expect(modelFields()[model]?.scalars).toContain('id');
    }
  });
});
