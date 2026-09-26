import { checkHealth } from '@sales-tracker/core';

export const dynamic = 'force-dynamic';

export async function GET() {
  const health = await checkHealth();
  return Response.json(health, { status: health.status === 'ok' ? 200 : 503 });
}
