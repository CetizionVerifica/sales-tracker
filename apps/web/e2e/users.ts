// Test-only credentials. The admin is seeded by global-setup.ts; the others are core's
// DEV_USERS (packages/core/system/seed.ts), so their passwords must match there.
export const E2E_USERS = {
  admin: { email: 'e2e-admin@example.test', password: 'e2e-admin-password' },
  sales: { email: 'sales@example.com', password: 'sales-dev-password' },
  sales2: { email: 'sales2@example.com', password: 'sales2-dev-password' },
  pm: { email: 'pm@example.com', password: 'pm-dev-password1' },
} as const;
