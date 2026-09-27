'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * What failed and what to do, with Retry (UI guide §6). No apologies and no raw error text:
 * the error itself is logged where it happened.
 */
export function ErrorState({
  message = 'Couldn’t load this page. Check your connection and try again.',
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const router = useRouter();
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center gap-3 px-4 py-10 text-center', className)}
    >
      <p>{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry ?? (() => router.refresh())}>
        Retry
      </Button>
    </div>
  );
}
