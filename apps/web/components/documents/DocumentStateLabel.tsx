import type { DocumentState } from '@sales-tracker/core/schemas';
import {
  FileCheck,
  FileMinus,
  FileSearch,
  FileWarning,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { DOCUMENT_STATE_LABELS } from '@/lib/purchase-order-labels';
import { cn } from '@/lib/utils';

const ICONS: Record<DocumentState, LucideIcon> = {
  none: FileMinus,
  reading: Loader2,
  toReview: FileSearch,
  reviewed: FileCheck,
  failed: FileWarning,
};

/** A record's current document as an icon plus text (M9 lists: icon never alone). */
export function DocumentStateLabel({ state }: { state: DocumentState }) {
  const Icon = ICONS[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap',
        state === 'toReview' ? 'text-foreground font-medium' : 'text-muted-foreground',
      )}
    >
      <Icon
        className={cn('size-3.5 shrink-0', state === 'reading' && 'animate-spin')}
        aria-hidden
      />
      {DOCUMENT_STATE_LABELS[state]}
    </span>
  );
}
