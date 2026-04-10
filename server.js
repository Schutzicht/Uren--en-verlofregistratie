// Local dev server — gebruikt dezelfde handler als de Vercel serverless function.
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApiRequest } = require('./lib/api');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
      const result = await handleApiRequest(req.method, parts, body);
      if (result.isRaw) {
        res.writeHead(result.status, result.headers || {});
        return res.end(result.body);
      }
      res.writeHead(result.status, { 'Content-Type': 'application/json', ...(result.headers || {}) });
      return res.end(JSON.stringify(result.body));
    }
    serveStatic(req, res);
  } catch (err) {
    console.error('Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Uren- en Verlofregistratie Tool draait op http://localhost:${PORT}`);
});
