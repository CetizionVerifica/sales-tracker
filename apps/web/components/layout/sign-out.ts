/**
 * Signs out through Better Auth. Returns false when the request failed (still signed in).
 * Better Auth rejects cookie-bearing POSTs without a JSON content type (415).
 */
export async function signOut(): Promise<boolean> {
  const response = await fetch('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return response.ok;
}
