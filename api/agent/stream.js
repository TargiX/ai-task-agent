import { streamAgentRun, writeSse } from '../../lib/agent-stream.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
    });
    await streamAgentRun({
      body: req.body || {},
      headers: req.headers,
      writeEvent: async (event) => writeSse(res, event),
    });
    res.end();
  } catch (error) {
    writeSse(res, {
      type: 'error',
      message: error.message || 'Server error',
    });
    res.end();
  }
}
