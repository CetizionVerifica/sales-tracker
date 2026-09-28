import { formatMoney, formatRate, rateFromDecimal } from '@sales-tracker/core/schemas';

const monthName = new Intl.DateTimeFormat('en-IN', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * The INR equivalent under a non-INR amount (M12 Decision 1): "≈ ₹10,37,500 at 83.00
 * INR/USD, Oct 2026", or that the month has no rate yet. Nothing for INR amounts.
 */
export function InrEquivalent({
  currency,
  amountInrMinor,
  fxRate,
  date,
}: {
  currency: string;
  amountInrMinor: bigint | null;
  fxRate: string | null;
  /** The day whose month sets the rate. */
  date: Date | null;
}) {
  if (currency === 'INR') return null;
  const month = date ? monthName.format(date) : null;
  return (
    <span className="text-muted-foreground block text-[13px]">
      {amountInrMinor !== null && fxRate
        ? `≈ ${formatMoney(amountInrMinor, 'INR')} at ${formatRate(rateFromDecimal(fxRate))} INR/${currency}${month ? `, ${month}` : ''}`
        : `No INR rate${month ? ` for ${month}` : ''} yet`}
    </span>
  );
}
