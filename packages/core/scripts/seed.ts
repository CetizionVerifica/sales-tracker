import { disconnectAll } from '../clients.ts';
import { getEnv } from '../env.ts';
import { seed } from '../system/seed.ts';

const env = getEnv();
try {
  await seed({
    adminEmail: env.SEED_ADMIN_EMAIL,
    adminPassword: env.SEED_ADMIN_PASSWORD,
    devUsers: env.NODE_ENV === 'development',
    log: (message) => console.log(`db:seed — ${message}`),
  });
} catch (error) {
  console.error(`db:seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await disconnectAll();
}
