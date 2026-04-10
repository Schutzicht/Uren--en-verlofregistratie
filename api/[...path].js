// Vercel serverless function — catch-all voor /api/*
const { handleApiRequest } = require('../lib/api');

module.exports = async (req, res) => {
  try {
    // Parse path: req.url is like "/api/hours/abc123?foo=1"
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);

    // Vercel parses JSON body automatically when content-type is application/json
    const body = req.body || {};

    const result = await handleApiRequest(req.method, parts, body);

    if (result.isRaw) {
      const headers = result.headers || {};
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      res.status(result.status).send(result.body);
      return;
    }

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message });
  }
};
