import { ChangePasswordForm } from './ChangePasswordForm';

export const metadata = { title: 'Change password · Sales Tracker' };

export default function ChangePasswordPage() {
  return (
    <section className="flex flex-col gap-4 py-8">
      <h1 className="text-2xl font-semibold">Change password</h1>
      <p className="text-muted-foreground text-sm">
        Other devices are signed out; this one stays signed in.
      </p>
      <ChangePasswordForm />
    </section>
  );
}
