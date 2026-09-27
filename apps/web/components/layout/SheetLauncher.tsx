'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * A button that opens a form sheet. The sheet also opens from the URL (`?new=1`,
 * `?edit=1`), so "+ New", the command palette and old /new and /edit links land on it;
 * closing removes the param again.
 */
export function SheetLauncher({
  param,
  label,
  variant = 'default',
  size,
  children,
}: {
  param: string;
  label: string;
  variant?: ComponentProps<typeof Button>['variant'];
  size?: ComponentProps<typeof Button>['size'];
  children: (open: boolean, onOpenChange: (open: boolean) => void) => ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(searchParams.get(param) === '1');

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next && searchParams.has(param)) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete(param);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {children(open, onOpenChange)}
    </>
  );
}
