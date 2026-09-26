import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// One .env for the whole monorepo lives at the root (absent in CI, where vars are set directly).
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@sales-tracker/core', '@sales-tracker/db'],
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'ioredis'],
};

export default nextConfig;
