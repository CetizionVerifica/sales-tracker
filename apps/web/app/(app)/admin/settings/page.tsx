import { getSettings } from '@sales-tracker/core';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireAdmin } from '@/lib/auth';
import { SettingsForm } from './SettingsForm';

export const metadata = { title: 'Settings · Sales Tracker' };

export default async function SettingsPage() {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows No access
  const settings = await getSettings(ctx);
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <PageHeader title="Settings" description="Company-wide defaults every user works with" />
      <div className="bg-card rounded-[var(--radius)] border p-6">
        <SettingsForm
          values={{
            companyName: settings.companyName,
            defaultInvoiceDueDays: settings.defaultInvoiceDueDays,
            enabledCurrencies: settings.enabledCurrencies,
            documentExtractionEnabled: settings.documentExtractionEnabled,
          }}
          baseCurrency={settings.baseCurrency}
        />
      </div>
    </div>
  );
}
