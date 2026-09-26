import { getSettings } from '@sales-tracker/core';
import { requireUser } from '@/lib/auth';
import { SettingsForm } from './SettingsForm';

export const metadata = { title: 'Settings · Sales Tracker' };

export default async function SettingsPage() {
  const settings = await getSettings(await requireUser());
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Company settings</h2>
      <SettingsForm
        values={{
          companyName: settings.companyName,
          defaultInvoiceDueDays: settings.defaultInvoiceDueDays,
          enabledCurrencies: settings.enabledCurrencies,
        }}
        baseCurrency={settings.baseCurrency}
      />
    </section>
  );
}
