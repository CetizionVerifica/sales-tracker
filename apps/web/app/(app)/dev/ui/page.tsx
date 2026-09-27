import { notFound } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { SummaryStrip } from '@/components/data/SummaryStrip';
import { DateDisplay } from '@/components/display/DateDisplay';
import { FieldGrid } from '@/components/display/FieldGrid';
import { Money } from '@/components/display/Money';
import { RelativeDue } from '@/components/display/RelativeDue';
import { UserAvatar } from '@/components/display/UserAvatar';
import { EmptyState } from '@/components/feedback/EmptyState';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { PipelineStrip, STAGES } from '@/components/pipeline/PipelineStrip';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { istToday } from '@/lib/display';
import { DevInteractive } from './DevInteractive';

export const metadata = { title: 'UI kit · Sales Tracker' };

const STATUSES = {
  enquiry: ['IN_PROGRESS', 'CONVERTED', 'LOST'],
  quotation: ['SENT', 'UNDER_NEGOTIATION', 'PO_RECEIVED', 'LOST'],
  project: ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'],
  po: ['PENDING', 'PAID', 'OVERDUE'],
  invoice: ['PENDING', 'PAID', 'OVERDUE'],
} as const;

function addDays(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Development only (UI guide §9): every shared component in every state, to check tokens,
 * light/dark and widths in one place. Returns 404 in production.
 */
export default function UiKitPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  const today = istToday();

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Dev', href: '/dev/ui' }, { label: 'UI kit' }]}
        title="UI kit"
        description="Every shared component in every state (development only)"
        badge={<MarkBadge tone="primary">Dev</MarkBadge>}
      />

      <Panel title="Status badges">
        <div className="flex flex-col gap-3">
          {Object.entries(STATUSES).map(([entity, statuses]) => (
            <div key={entity} className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground w-24 text-[13px] capitalize">{entity}</span>
              {statuses.map((status) => (
                <StatusBadge
                  key={status}
                  entity={entity as keyof typeof STATUSES}
                  status={status}
                />
              ))}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <MarkBadge>Neutral</MarkBadge>
            <MarkBadge tone="success">Active</MarkBadge>
            <MarkBadge tone="destructive">Deleted</MarkBadge>
            <MarkBadge tone="primary">Primary</MarkBadge>
          </div>
        </div>
      </Panel>

      <Panel title="Pipeline strip">
        <div className="flex flex-col gap-4">
          {STAGES.map((stage) => (
            <PipelineStrip
              key={stage.id}
              current={stage.id}
              links={{ enquiry: '#', quotation: '#', project: '#', po: '#', invoice: '#' }}
            />
          ))}
          <PipelineStrip current="enquiry" reached="quotation" links={{ quotation: '#' }} />
        </div>
      </Panel>

      <Panel title="Display">
        <FieldGrid
          items={[
            { label: 'Money (INR)', value: <Money amountMinor={125000000n} currency="INR" /> },
            { label: 'Money (USD)', value: <Money amountMinor={4500050n} currency="USD" /> },
            { label: 'Date', value: <DateDisplay value={`${today}T00:00:00.000Z`} /> },
            { label: 'Date and time', value: <DateDisplay value={new Date()} withTime /> },
            { label: 'Empty date', value: <DateDisplay value={null} /> },
            { label: 'Due today', value: <RelativeDue date={today} today={today} /> },
            { label: 'Overdue', value: <RelativeDue date={addDays(today, -3)} today={today} /> },
            { label: 'Upcoming', value: <RelativeDue date={addDays(today, 5)} today={today} /> },
            {
              label: 'Overdue on a closed record',
              value: <RelativeDue date={addDays(today, -3)} today={today} active={false} />,
            },
            {
              label: 'Avatars',
              value: (
                <span className="flex gap-3">
                  <UserAvatar name="Sam Sales" />
                  <UserAvatar name="Anita Rao" size="md" showName />
                </span>
              ),
            },
            {
              label: 'Long text',
              value: 'A wide field spans both columns. '.repeat(4),
              wide: true,
            },
          ]}
        />
      </Panel>

      <Panel title="Summary strip">
        <SummaryStrip
          chips={[
            { label: 'Follow-up due', count: 4, href: '#', attention: true },
            { label: 'Sent', count: 12, href: '#', active: true },
            { label: 'Under negotiation', count: 3, href: '#' },
            { label: 'PO received', count: 0, href: '#' },
          ]}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Loading">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        </Panel>
        <Panel title="Empty">
          <EmptyState message="No enquiries yet. Add the first one when a client gets in touch." />
        </Panel>
        <Panel title="No access">
          <NoAccess />
        </Panel>
        <DevInteractive />
      </div>
    </>
  );
}
