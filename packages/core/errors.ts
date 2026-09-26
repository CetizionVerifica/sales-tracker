/** No valid session. Web maps this to a sign-in redirect or an action error. */
export class UnauthenticatedError extends Error {
  override name = 'UnauthenticatedError';
  constructor(message = 'Not signed in') {
    super(message);
  }
}

/** can() said no. The message names the action and resource type only, never record data. */
export class ForbiddenError extends Error {
  override name = 'ForbiddenError';
  constructor(action: string, resourceType: string) {
    super(`Not allowed to ${action} ${resourceType}`);
  }
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
  constructor(resourceType: string) {
    super(`${resourceType} not found`);
  }
}

/**
 * A business-rule violation whose message is safe to show to the user. `field` points the
 * UI at the input it concerns (e.g. a duplicate name), mapped to fieldErrors by actions.
 */
export class DomainError extends Error {
  override name = 'DomainError';
  readonly field: string | undefined;

  constructor(message: string, options: { field?: string } = {}) {
    super(message);
    this.field = options.field;
  }
}

/**
 * An audited write ran without an acting context or outside withTx (M2: fails closed).
 * Always a programming error: wrap the write in withTx(ctx, …).
 */
export class AuditContextError extends Error {
  override name = 'AuditContextError';
}

/** A hard delete on a soft-deletable model (CLAUDE.md rule 4): set `deletedAt` instead. */
export class SoftDeleteError extends Error {
  override name = 'SoftDeleteError';
}
