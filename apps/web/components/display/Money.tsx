import { formatMoney } from '@sales-tracker/core/schemas';
import { cn } from '@/lib/utils';

/**
 * Money in its own currency, Indian grouping (₹12,50,000), tabular figures (UI guide §5).
 * `amountMinor` may be a string where a bigint cannot cross to a client component.
 */
export function Money({
  amountMinor,
  currency,
  className,
}: {
  amountMinor: bigint | string;
  currency: string;
  className?: string;
}) {
  return (
    <span className={cn('num whitespace-nowrap', className)}>
      {formatMoney(typeof amountMinor === 'string' ? BigInt(amountMinor) : amountMinor, currency)}
    </span>
  );
}
