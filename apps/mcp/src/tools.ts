import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const SERVER_VERSION = '0.0.0';

/**
 * Builds the MCP server and registers its tools. Tools must call packages/core services
 * with ctx.source = 'mcp' (M13 adds token auth and the data tools).
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'sales-tracker', version: SERVER_VERSION });

  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description:
        'Connectivity check. Reads no data and writes nothing; returns { ok: true, version } ' +
        'so a client can confirm it reached the Sales Tracker MCP server.',
      inputSchema: {},
      outputSchema: { ok: z.literal(true), version: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const output = { ok: true as const, version: SERVER_VERSION };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  return server;
}
