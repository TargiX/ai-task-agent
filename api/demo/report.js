import { handleApiRequest } from '../../lib/api-core.js';

export default async function handler(req, res) {
  const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);

  try {
    const result = await handleApiRequest({
      method: req.method,
      pathname: '/api/demo/report',
      query: Object.fromEntries(url.searchParams.entries()),
      body: req.method === 'GET' ? {} : req.body || {},
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
}
