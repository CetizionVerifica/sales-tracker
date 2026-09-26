import { disconnectAll, getEnv } from '@sales-tracker/core';
import { createMcpHttpServer } from './server.ts';

const env = getEnv(); // fail fast on bad config
// Bound to localhost until token auth ships in M13.
const HOST = '127.0.0.1';
const server = createMcpHttpServer();
server.listen(env.MCP_PORT, HOST, () => {
  console.log(`mcp server listening on http://${HOST}:${env.MCP_PORT}/mcp`);
});

async function shutdown() {
  server.close();
  await disconnectAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
