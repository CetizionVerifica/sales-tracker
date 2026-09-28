import { getSettings, listExchangeRates } from '@sales-tracker/core';
import { toCalendarDateString, todayInIST } from '@sales-tracker/core/schemas';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireAdmin } from '@/lib/auth';
import { RateDialog } from './RateDialog';
import { RatesTable } from './RatesTable';

export const metadata = { title: 'Exchange rates · Sales Tracker' };

/**
 * Monthly exchange rates (M12 Decision 1): every quotation, project, PO and invoice in
 * another currency stores its INR value at its own month's rate.
 */
export default async function ExchangeRatesPage() {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows No access
  const [rows, settings] = await Promise.all([listExchangeRates(ctx), getSettings(ctx)]);
  const currencies = settings.enabledCurrencies.filter((c) => c !== settings.baseCurrency);
  const thisMonth = toCalendarDateString(todayInIST()).slice(0, 7);
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <PageHeader
        title="Exchange rates"
        description="INR per unit for each month; records in other currencies convert at their month's rate"
        actions={<RateDialog currencies={currencies} thisMonth={thisMonth} />}
      />
      {currencies.length === 0 && (
        <p className="text-muted-foreground text-[13px]">
          Only INR is enabled. Enable another currency in Settings to add its rates.
        </p>
      )}
      <RatesTable
        rows={rows.map(({ id, currency, month, rate, recordCount, staleCount }) => ({
          id,
          currency,
          month,
          rate,
          recordCount,
          staleCount,
        }))}
        currencies={currencies}
        thisMonth={thisMonth}
      />
    </div>
  );
}
