/** Where sign-in lands by default: My today, every role's home (M11 Decision 9). */
export const HOME_PATH = '/today';

/** Only same-site relative paths are allowed as post-login targets (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return HOME_PATH;
  }
  return next;
}
