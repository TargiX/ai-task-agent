import { handleApiRequest } from '../../lib/api-core.js';

export default async function handler(req, res) {
  try {
    const result = await handleApiRequest({
      method: req.method,
      pathname: '/api/setup/verify',
      body: req.method === 'GET' ? {} : req.body || {},
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
}
