import { getCtx } from '@/lib/auth';
import { safeNext } from '@/lib/safe-next';
import { redirect } from 'next/navigation';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in · Sales Tracker' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNext((await searchParams).next);
  const signedIn = await getCtx().then(
    () => true,
    () => false,
  );
  if (signedIn) redirect(next);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <LoginForm next={next} />
    </main>
  );
}
