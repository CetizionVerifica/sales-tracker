import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { initials } from '@/lib/display';
import { cn } from '@/lib/utils';

/** Initials on --secondary: 24px in tables, 32px in headers (UI guide §5). */
export function UserAvatar({
  name,
  size = 'sm',
  showName = false,
  className,
}: {
  name: string;
  size?: 'sm' | 'md';
  showName?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Avatar className={size === 'sm' ? 'size-6' : 'size-8'}>
        <AvatarFallback
          className={cn(
            'bg-secondary text-secondary-foreground font-medium',
            size === 'sm' ? 'text-[11px]' : 'text-xs',
          )}
          title={name}
        >
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      {showName ? <span>{name}</span> : <span className="sr-only">{name}</span>}
    </span>
  );
}
