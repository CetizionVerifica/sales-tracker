'use client';

import { ChevronDown, Moon, Plus, Search, Sun } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useState } from 'react';
import { toast } from 'sonner';
import { UserAvatar } from '@/components/display/UserAvatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarTrigger } from '@/components/ui/sidebar';
import type { NewMenuItem, ShellUser } from './nav';
import { signOut } from './sign-out';

/** Opens the ⌘K command palette (CommandPalette listens for this event). */
export const OPEN_PALETTE_EVENT = 'open-command-palette';

/** The 56px top bar (UI guide §3): search, + New, and the user menu with the theme choice. */
export function TopBar({ user, newItems }: { user: ShellUser; newItems: NewMenuItem[] }) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    if (!(await signOut())) {
      setSigningOut(false);
      toast.error('Couldn’t sign out. Try again.');
      return;
    }
    router.replace('/login');
    router.refresh();
  }

  return (
    <header className="bg-card sticky top-0 z-20 flex h-14 items-center gap-2 border-b px-4 lg:px-6">
      <SidebarTrigger aria-label="Toggle navigation" />
      <Button
        variant="outline"
        aria-label="Search records"
        className="text-muted-foreground min-w-0 flex-1 justify-start gap-2 font-normal sm:w-72 sm:flex-none"
        onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
      >
        <Search className="size-4" aria-hidden />
        <span className="truncate">Search…</span>
        <kbd className="bg-muted ml-auto hidden rounded px-1.5 text-xs sm:inline">⌘K</kbd>
      </Button>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {newItems.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" aria-label="New">
                <Plus aria-hidden />
                <span className="hidden sm:inline">New</span>
                <ChevronDown className="hidden sm:block" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {newItems.map((item) => (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href}>{item.label}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2 px-1.5 sm:px-2" aria-label="User menu">
              <UserAvatar name={user.name} size="md" />
              <span className="hidden text-left md:block">{user.name}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col font-normal">
              <span className="font-medium">{user.name}</span>
              <span className="text-muted-foreground text-[13px]">
                {user.roleLabel} · {user.email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/activity">My activity</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/account/password">Change password</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">
              Theme
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={resolvedTheme === 'dark' ? 'dark' : 'light'}
              onValueChange={setTheme}
            >
              <DropdownMenuRadioItem value="light">
                <Sun aria-hidden />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon aria-hidden />
                Dark
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={signingOut} onSelect={handleSignOut}>
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
