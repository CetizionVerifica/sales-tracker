'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Admins: whose My Today to view (Decision 6), synced to `?user=`. */
export function ViewingSelect({
  meId,
  value,
  users,
}: {
  meId: string;
  value: string;
  users: { id: string; name: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="today-viewing" className="text-muted-foreground text-[13px]">
        Viewing
      </label>
      <Select
        value={value}
        onValueChange={(id) => {
          const next = new URLSearchParams(params);
          if (id === meId) next.delete('user');
          else next.set('user', id);
          const query = next.toString();
          router.push(query ? `/today?${query}` : '/today');
        }}
      >
        <SelectTrigger id="today-viewing" className="w-[200px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={meId}>Me</SelectItem>
          {users
            .filter((user) => user.id !== meId)
            .map((user) => (
              <SelectItem key={user.id} value={user.id}>
                {user.name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}
