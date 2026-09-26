import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { checkHealth } from '@sales-tracker/core';
import { createMcpServer } from './tools.ts';

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. */
async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createMcpHttpServer() {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const handle = async () => {
      if (path === '/mcp') return handleMcp(req, res);
      if (path === '/health' && req.method === 'GET') {
        const health = await checkHealth();
        return sendJson(res, health.status === 'ok' ? 200 : 503, health);
      }
      sendJson(res, 404, { error: 'Not found' });
    };
    handle().catch((error: unknown) => {
      console.error('mcp request failed', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
  });
}
