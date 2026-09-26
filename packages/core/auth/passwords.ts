import { getDb } from '../clients.ts';
import { getAuth } from './auth.ts';

/**
 * Password operations for core services. The admin plugin's setUserPassword needs an admin
 * session, so these use Better Auth's internal context directly; its adapter runs on our
 * transaction client (authDb), so writes are audited and roll back with withTx (M3 spike).
 */

/** Checks a password against the user's credential account. */
export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const account = await getDb().account.findFirst({
    where: { userId, providerId: 'credential' },
    select: { password: true },
  });
  if (!account?.password) return false;
  const context = await getAuth().$context;
  return context.password.verify({ hash: account.password, password });
}

/** Sets a new password on the credential account. Call inside withTx (audited write). */
export async function setUserPassword(userId: string, password: string): Promise<void> {
  const context = await getAuth().$context;
  await context.internalAdapter.updatePassword(userId, await context.password.hash(password));
}

/** True when the user has a password-based account to reset. */
export async function hasCredentialAccount(userId: string): Promise<boolean> {
  const count = await getDb().account.count({ where: { userId, providerId: 'credential' } });
  return count > 0;
}
