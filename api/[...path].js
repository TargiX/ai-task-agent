import { handleApiRequest } from '../lib/api-core.js';
import { streamAgentRun, writeSse } from '../lib/agent-stream.js';

export default async function handler(req, res) {
  const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/api/agent/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
      });
      await streamAgentRun({
        body: req.body || {},
        headers: req.headers,
        query: Object.fromEntries(url.searchParams.entries()),
        writeEvent: async (event) => writeSse(res, event),
      });
      res.end();
      return;
    }

    const result = await handleApiRequest({
      method: req.method,
      pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      body: req.method === 'GET' ? {} : req.body || {},
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(error);
    if (pathname === '/api/agent/stream') {
      writeSse(res, { type: 'error', message: error.message || 'Server error' });
      res.end();
      return;
    }
    res.status(500).json({ error: error.message || 'Server error' });
  }
}
