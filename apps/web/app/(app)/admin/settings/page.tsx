import { getSettings } from '@sales-tracker/core';
import { requireAdmin } from '@/lib/auth';
import { SettingsForm } from './SettingsForm';

export const metadata = { title: 'Settings · Sales Tracker' };

export default async function SettingsPage() {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows Forbidden
  const settings = await getSettings(ctx);
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
