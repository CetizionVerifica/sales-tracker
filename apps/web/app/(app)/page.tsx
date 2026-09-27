import {
  can,
  enquiryStatusCounts,
  getCurrentUser,
  quotationStatusCounts,
} from '@sales-tracker/core';
import Link from 'next/link';
import { Panel } from '@/components/charts/Panel';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireUser } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Home: a starting point inside the shell until My today (M11) and the Dashboard (M12)
 * arrive. The numbers are the same scoped counts the list summary strips use.
 */
export default async function HomePage() {
  const ctx = await requireUser();
  const me = await getCurrentUser(ctx);
  const [enquiries, quotations] = await Promise.all([
    can(ctx.user, 'list', 'enquiry') ? enquiryStatusCounts(ctx) : null,
    can(ctx.user, 'list', 'quotation') ? quotationStatusCounts(ctx) : null,
  ]);

  const tiles = [
    ...(quotations
      ? [
          {
            label: 'Quotation follow-ups due',
            value: quotations.followUpDue,
            href: '/quotations?followUpDue=true',
            attention: quotations.followUpDue > 0,
          },
          {
            label: 'Open quotations',
            value: quotations.SENT + quotations.UNDER_NEGOTIATION,
            href: '/quotations?status=SENT,UNDER_NEGOTIATION',
          },
        ]
      : []),
    ...(enquiries
      ? [
          {
            label: 'Enquiries in progress',
            value: enquiries.IN_PROGRESS,
            href: '/enquiries?status=IN_PROGRESS',
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={`Hello, ${me.name.split(' ')[0]}`}
        description="Where your pipeline stands today"
      />
      {tiles.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map((tile) => (
            <Link
              key={tile.label}
              href={tile.href}
              className={cn(
                'bg-card hover:bg-accent flex flex-col gap-1 rounded-[var(--radius)] border p-4',
                tile.attention && 'bg-attention-soft',
              )}
            >
              <span
                className={cn(
                  'text-[13px]',
                  tile.attention ? 'text-attention-foreground' : 'text-muted-foreground',
                )}
              >
                {tile.label}
              </span>
              <span className="num text-[28px] leading-[34px] font-semibold">{tile.value}</span>
            </Link>
          ))}
        </div>
      ) : (
        <Panel>
          <p className="text-muted-foreground">
            Your projects and invoices will appear here once those modules arrive.
          </p>
        </Panel>
      )}
    </>
  );
}
