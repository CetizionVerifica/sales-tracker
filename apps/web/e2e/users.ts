// Test-only credentials. The admin is seeded by global-setup.ts; the sales user is one of
// core's DEV_USERS (packages/core/system/seed.ts), so its password must match there.
export const E2E_USERS = {
  admin: { email: 'e2e-admin@example.test', password: 'e2e-admin-password' },
  sales: { email: 'sales@example.com', password: 'sales-dev-password' },
  sales2: { email: 'sales2@example.com', password: 'sales2-dev-password' },
} as const;
