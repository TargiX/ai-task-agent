import './lib/env.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { handleApiRequest } from './lib/api-core.js';
import { streamAgentRun, writeSse } from './lib/agent-stream.js';
import { providerStatus } from './lib/domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON request body.');
    error.status = 400;
    throw error;
  }
}

function sendJson(res, status, body) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function handleLocalApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/agent/stream') {
      const body = await readJson(req);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
      });
      try {
        await streamAgentRun({
          body,
          writeEvent: async (event) => writeSse(res, event),
        });
      } catch (streamError) {
        console.error(streamError);
        if (!res.writableEnded) {
          writeSse(res, { type: 'error', message: streamError.message || 'Server error' });
        }
      }
      if (!res.writableEnded) res.end();
      return;
    }

    const result = await handleApiRequest({
      method: req.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body: req.method === 'GET' ? {} : await readJson(req),
    });
    sendJson(res, result.status, result.body);
  } catch (error) {
    console.error(error);
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const status = Number(error.status) || 500;
    sendJson(res, status, { error: error.message || 'Server error' });
  }
}

async function main() {
  const vite =
    process.env.NODE_ENV === 'production'
      ? null
      : await createViteServer({
          server: { middlewareMode: true, hmr: false },
          appType: 'spa',
        });

  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/api/')) {
      await handleLocalApi(req, res);
      return;
    }

    if (vite) {
      vite.middlewares(req, res);
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(__dirname, 'dist', requested);
    try {
      const body = await fs.readFile(filePath);
      const type = filePath.endsWith('.js')
        ? 'text/javascript'
        : filePath.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    } catch {
      const body = await fs.readFile(path.join(__dirname, 'dist', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`AI Task Agent running at http://${HOST}:${PORT}/`);
    console.log(`Provider: ${JSON.stringify(providerStatus())}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
