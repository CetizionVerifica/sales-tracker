import { PageHeader } from '@/components/layout/PageHeader';
import { ChangePasswordForm } from './ChangePasswordForm';

export const metadata = { title: 'Change password · Sales Tracker' };

export default function ChangePasswordPage() {
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <PageHeader
        title="Change password"
        description="Other devices are signed out; this one stays signed in."
      />
      <div className="bg-card max-w-xl rounded-[var(--radius)] border p-6">
        <ChangePasswordForm />
      </div>
    </div>
  );
}
