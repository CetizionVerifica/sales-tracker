import { getDb } from '../clients.ts';
import { assertCan, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { scopeUsers } from '../rbac/scope.ts';
import { paginationSchema, type Page, type PaginationInput } from '../schemas/common.ts';
import { userIdSchema } from '../schemas/user.ts';

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

export async function listUsers(ctx: Ctx, input: PaginationInput): Promise<Page<PublicUser>> {
  const { page, pageSize } = paginationSchema.parse(input);
  assertCan(ctx, 'list', 'user');
  const where = scopeUsers(ctx.user);
  const db = getDb();
  const [items, total] = await db.$transaction([
    db.user.findMany({
      where,
      select: publicUserSelect,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.user.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

/** Deactivates a user and revokes all their sessions (M1 Decision 4). Admin only. */
export async function deactivateUser(ctx: Ctx, id: string): Promise<PublicUser> {
  const userId = userIdSchema.parse(id);
  assertCan(ctx, 'update', { type: 'user', id: userId });
  if (userId === ctx.user.id) throw new DomainError('You cannot deactivate yourself');

  const db = getDb();
  const target = await db.user.findUnique({ where: { id: userId }, select: { isSystem: true } });
  if (!target) throw new NotFoundError('user');
  if (target.isSystem) throw new DomainError('The system user cannot be deactivated');

  const [user] = await db.$transaction([
    db.user.update({ where: { id: userId }, data: { active: false }, select: publicUserSelect }),
    db.session.deleteMany({ where: { userId } }),
  ]);
  return user;
}
