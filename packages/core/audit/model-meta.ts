import { Prisma } from '@sales-tracker/db';

/**
 * Models the audit extension skips, each with the reason (M2 Decision 3). Every other
 * model is audited by default; AC13's coverage test enforces this list stays explicit.
 */
export const AUDIT_EXCLUDED = {
  AuditLog: 'The audit trail itself; append-only and written only by this extension.',
  Session:
    'Auth plumbing rewritten on every sign-in and session refresh; carries no business data.',
  Verification: 'Short-lived auth tokens; carries no business data.',
  ImportRow:
    'M10b staging state, rewritten on every re-validation while a batch is worked on; not a ' +
    'business record. The record it produces at commit (e.g. Enquiry) is audited normally.',
} as const satisfies Partial<Record<Prisma.ModelName, string>>;

export interface ModelFields {
  scalars: string[];
  relations: string[];
}

type RuntimeDataModel = {
  models: Record<string, { fields: { name: string; kind: string }[] }>;
};

// On globalThis for the same reason as the audit store: module copies must share it.
const globalForMeta = globalThis as unknown as {
  salesTrackerModelMeta?: Record<string, ModelFields>;
};

/**
 * Captures per-model field metadata from the client. Prisma does not export it publicly, so
 * this reads the client's internal `_runtimeDataModel` in this one place; AC13's test fails
 * loudly if a Prisma upgrade removes it.
 */
export function registerModelMeta(client: unknown): void {
  const runtime = (client as { _runtimeDataModel?: RuntimeDataModel })._runtimeDataModel;
  if (!runtime) throw new Error('Prisma client has no _runtimeDataModel; update model-meta.ts');
  globalForMeta.salesTrackerModelMeta = Object.fromEntries(
    Object.entries(runtime.models).map(([name, model]) => [
      name,
      {
        scalars: model.fields.filter((f) => f.kind !== 'object').map((f) => f.name),
        relations: model.fields.filter((f) => f.kind === 'object').map((f) => f.name),
      },
    ]),
  );
}

export function modelFields(): Record<string, ModelFields> {
  const meta = globalForMeta.salesTrackerModelMeta;
  if (!meta) throw new Error('Model metadata not registered; call getDb() first');
  return meta;
}

export function isAudited(model: string): boolean {
  return !(model in AUDIT_EXCLUDED);
}

export function auditedModels(): string[] {
  return Object.values(Prisma.ModelName).filter(isAudited);
}
