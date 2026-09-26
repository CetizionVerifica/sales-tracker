// Edge-safe subpath (@sales-tracker/core/auth-cookie) for the Next.js proxy: reading the
// cookie must not pull Prisma or the auth config into the proxy bundle.
export { getSessionCookie } from 'better-auth/cookies';
