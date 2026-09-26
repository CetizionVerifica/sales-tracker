import { getAuth } from '../auth/auth.ts';
import { hasCredentialAccount, setUserPassword, verifyUserPassword } from '../auth/passwords.ts';
import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { scopeUsers } from '../rbac/scope.ts';
import type { Page } from '../schemas/common.ts';
import {
  changeOwnPasswordSchema,
  createUserSchema,
  listUsersSchema,
  resetPasswordSchema,
  updateUserSchema,
  userIdSchema,
  type ChangeOwnPasswordInput,
  type CreateUserInput,
  type ListUsersInput,
  type ResetPasswordInput,
  type UpdateUserInput,
} from '../schemas/user.ts';
import { guardUnique } from './unique.ts';

/** Fields safe to return to any caller (no auth plumbing or ban fields). */
const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  createdAt: true,
} as const;

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: Ctx['user']['role'];
  active: boolean;
  createdAt: Date;
};

const EMAIL_TAKEN = 'A user with this email already exists';

/** Finds a user that admins may manage: never the system user (M1 Decision 5). */
async function findManagedUser(db: Db, id: string) {
  const user = await db.user.findFirst({
    where: { id, isSystem: false },
    select: { id: true, role: true, active: true },
  });
  if (!user) throw new NotFoundError('user');
  return user;
}

async function assertEmailFree(db: Db, email: string, excludeId?: string) {
  const clash = await db.user.findFirst({
    where: {
      email: { equals: email, mode: 'insensitive' },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new DomainError(EMAIL_TAKEN, { field: 'email' });
}

/** Nobody may demote or deactivate the last active admin (M3 Decision 6). */
async function assertNotLastAdmin(db: Db, userId: string, field?: string) {
  const others = await db.user.count({
    where: { role: 'ADMIN', active: true, isSystem: false, id: { not: userId } },
  });
  if (others === 0) {
    throw new DomainError('The company must keep at least one active admin', { field });
  }
}

export async function getCurrentUser(ctx: Ctx): Promise<PublicUser> {
  return getUser(ctx, ctx.user.id);
}

export async function getUser(ctx: Ctx, id: string): Promise<PublicUser> {
  const userId = userIdSchema.parse(id);
  assertCan(ctx, 'read', { type: 'user', id: userId });
  const user = await getDb().user.findFirst({
    where: { id: userId, isSystem: false },
    select: publicUserSelect,
  });
  if (!user) throw new NotFoundError('user');
  return user;
}

export async function listUsers(ctx: Ctx, input: ListUsersInput): Promise<Page<PublicUser>> {
  const { page, pageSize, q, role, status, sort, dir } = listUsersSchema.parse(input);
  assertCan(ctx, 'list', 'user');
  const where = {
    AND: [
      scopeUsers(ctx.user),
      {
        ...(role && { role }),
        ...(status && { active: status === 'active' }),
        ...(q && {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
          ],
        }),
      },
    ],
  };
  const db = getDb();
  const [items, total] = await Promise.all([
    db.user.findMany({
      where,
      select: publicUserSelect,
      orderBy: [{ [sort ?? 'name']: dir ?? 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.user.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

/**
 * Creates a user with an admin-set initial password (no email in v1). Better Auth's admin
 * API runs inside withTx, so the User and Account rows are audited together.
 */
export async function createUser(ctx: Ctx, input: CreateUserInput): Promise<PublicUser> {
  const data = createUserSchema.parse(input);
  assertCan(ctx, 'create', 'user');
  return withTx(ctx, async (tx) => {
    await assertEmailFree(tx, data.email);
    const { user } = await guardUnique('email', EMAIL_TAKEN, () =>
      getAuth().api.createUser({ body: data }),
    );
    return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: publicUserSelect });
  });
}

export async function updateUser(
  ctx: Ctx,
  id: string,
  input: UpdateUserInput,
): Promise<PublicUser> {
  const userId = userIdSchema.parse(id);
  const data = updateUserSchema.parse(input);
  assertCan(ctx, 'update', { type: 'user', id: userId });
  return withTx(ctx, async (tx) => {
    const target = await findManagedUser(tx, userId);
    if (data.role && data.role !== target.role) {
      if (userId === ctx.user.id) {
        throw new DomainError('You cannot change your own role', { field: 'role' });
      }
      if (target.role === 'ADMIN' && target.active) await assertNotLastAdmin(tx, userId, 'role');
    }
    if (data.email) await assertEmailFree(tx, data.email, userId);
    return guardUnique('email', EMAIL_TAKEN, () =>
      tx.user.update({ where: { id: userId }, data, select: publicUserSelect }),
    );
  });
}

/** Deactivates a user and revokes all their sessions (M1 Decision 4). Admin only. */
export async function deactivateUser(ctx: Ctx, id: string): Promise<PublicUser> {
  const userId = userIdSchema.parse(id);
  assertCan(ctx, 'update', { type: 'user', id: userId });
  if (userId === ctx.user.id) throw new DomainError('You cannot deactivate yourself');

  return withTx(ctx, async (tx) => {
    const target = await tx.user.findUnique({
      where: { id: userId },
      select: { isSystem: true, role: true, active: true },
    });
    if (!target) throw new NotFoundError('user');
    if (target.isSystem) throw new DomainError('The system user cannot be deactivated');
    if (target.role === 'ADMIN' && target.active) await assertNotLastAdmin(tx, userId);

    const user = await tx.user.update({
      where: { id: userId },
      data: { active: false },
      select: publicUserSelect,
    });
    // Sessions are not audited (M2 Decision 3); the User update above is.
    await tx.session.deleteMany({ where: { userId } });
    return user;
  });
}

export async function reactivateUser(ctx: Ctx, id: string): Promise<PublicUser> {
  const userId = userIdSchema.parse(id);
  assertCan(ctx, 'update', { type: 'user', id: userId });
  return withTx(ctx, async (tx) => {
    await findManagedUser(tx, userId);
    return tx.user.update({
      where: { id: userId },
      data: { active: true },
      select: publicUserSelect,
    });
  });
}

/** Sets an admin-chosen temporary password and signs the user out everywhere. */
export async function resetUserPassword(
  ctx: Ctx,
  id: string,
  input: ResetPasswordInput,
): Promise<void> {
  const userId = userIdSchema.parse(id);
  const { password } = resetPasswordSchema.parse(input);
  assertCan(ctx, 'update', { type: 'user', id: userId });
  await withTx(ctx, async (tx) => {
    await findManagedUser(tx, userId);
    if (!(await hasCredentialAccount(userId))) {
      throw new DomainError('This user has no password to reset');
    }
    await setUserPassword(userId, password);
    await tx.session.deleteMany({ where: { userId } });
  });
}

/**
 * Any signed-in user changes their own password (replaces Better Auth's /change-password,
 * disabled in M2). Keeps the current session and revokes the others.
 */
export async function changeOwnPassword(ctx: Ctx, input: ChangeOwnPasswordInput): Promise<void> {
  const { currentPassword, newPassword } = changeOwnPasswordSchema.parse(input);
  // Only the caller's own record; the general 'update user' permission stays admin-only.
  assertCan(ctx, 'read', { type: 'user', id: ctx.user.id });
  await withTx(ctx, async (tx) => {
    if (!(await verifyUserPassword(ctx.user.id, currentPassword))) {
      throw new DomainError('Current password is incorrect', { field: 'currentPassword' });
    }
    await setUserPassword(ctx.user.id, newPassword);
    await tx.session.deleteMany({
      where: { userId: ctx.user.id, ...(ctx.sessionId ? { id: { not: ctx.sessionId } } : {}) },
    });
  });
}
