'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/feedback/ErrorState';

/** Any page that fails to load: what failed and Retry (UI guide §6); the error is logged. */
export default function PageError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="bg-card rounded-[var(--radius)] border">
      <ErrorState
        message="Couldn’t load this page. Check your connection and try again."
        onRetry={retry}
      />
    </div>
  );
}
