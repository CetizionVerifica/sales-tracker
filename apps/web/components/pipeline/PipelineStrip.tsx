import Link from 'next/link';
import { Fragment } from 'react';
import { cn } from '@/lib/utils';

export const STAGES = [
  { id: 'enquiry', label: 'Enquiry', color: 'bg-stage-enquiry', border: 'border-stage-enquiry' },
  {
    id: 'quotation',
    label: 'Quotation',
    color: 'bg-stage-quotation',
    border: 'border-stage-quotation',
  },
  { id: 'project', label: 'Project', color: 'bg-stage-project', border: 'border-stage-project' },
  { id: 'po', label: 'PO', color: 'bg-stage-po', border: 'border-stage-po' },
  { id: 'invoice', label: 'Invoice', color: 'bg-stage-invoice', border: 'border-stage-invoice' },
] as const;

export type StageId = (typeof STAGES)[number]['id'];

/**
 * The app's signature element (UI guide §4.2): the five stages, reached ones as filled dots
 * in their stage colour linking to that record, later ones hollow grey. Identical on every
 * pipeline record.
 */
export function PipelineStrip({
  current,
  reached: furthest = current,
  links = {},
}: {
  /** The stage of the record on this page (bold). */
  current: StageId;
  /** The furthest stage the deal has reached (e.g. an enquiry that has a quotation). */
  reached?: StageId;
  /** Where each reached stage's record lives (e.g. the enquiry a quotation came from). */
  links?: Partial<Record<StageId, string>>;
}) {
  const reached = STAGES.findIndex((stage) => stage.id === furthest);
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);
  return (
    <nav aria-label="Pipeline" className="overflow-x-auto">
      <ol className="flex min-w-max items-center gap-2 text-[13px]">
        {STAGES.map((stage, index) => {
          const done = index <= reached;
          const isCurrent = index === currentIndex;
          const href = links[stage.id];
          const dot = (
            <span
              className={cn(
                'size-2.5 shrink-0 rounded-full border-2',
                done ? cn(stage.color, stage.border) : 'border-neutral bg-transparent',
              )}
              aria-hidden
            />
          );
          const label = (
            <span
              className={cn(
                done ? 'text-foreground' : 'text-muted-foreground',
                isCurrent && 'font-semibold',
              )}
            >
              {stage.label}
            </span>
          );
          return (
            <Fragment key={stage.id}>
              {index > 0 && (
                <li aria-hidden className={cn('h-px w-8', done ? stage.color : 'bg-border')} />
              )}
              <li aria-current={isCurrent ? 'step' : undefined}>
                {done && href && !isCurrent ? (
                  <Link href={href} className="inline-flex items-center gap-1.5 hover:underline">
                    {dot}
                    {label}
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    {dot}
                    {label}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
