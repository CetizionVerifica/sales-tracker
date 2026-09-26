import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { disconnectAll } from '@sales-tracker/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpHttpServer } from '../src/server.ts';

const server = createMcpHttpServer();
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await disconnectAll();
});

describe('MCP server (integration)', () => {
  it('lists exactly one tool, ping, and ping returns ok', async () => {
    const client = new Client({ name: 'm0-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['ping']);

    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result.structuredContent).toMatchObject({ ok: true });
    await client.close();
  });

  it('serves GET /health from core.checkHealth', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('returns 404 for unknown paths', async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
  });
});
