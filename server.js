require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// DB row → client-friendly user object
function userFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    photo: row.photo,
    weekNorm: Number(row.week_norm),
    leaveHoursPerYear: Number(row.leave_hours_per_year),
    workdays: row.workdays || [1, 2, 3, 4, 5]
  };
}
function entryFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    date: row.date,
    hours: Number(row.hours),
    note: row.note || ''
  };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
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

async function getFullState() {
  const [usersRes, hoursRes, leaveRes, holidaysRes, settingsRes] = await Promise.all([
    supabase.from('uren_users').select('*').order('id'),
    supabase.from('uren_hours').select('*').order('date', { ascending: false }),
    supabase.from('uren_leave').select('*').order('date', { ascending: false }),
    supabase.from('uren_holidays').select('*').order('date'),
    supabase.from('uren_settings').select('*').eq('key', 'app').maybeSingle()
  ]);

  if (usersRes.error) throw usersRes.error;
  if (hoursRes.error) throw hoursRes.error;
  if (leaveRes.error) throw leaveRes.error;
  if (holidaysRes.error) throw holidaysRes.error;
  if (settingsRes.error) throw settingsRes.error;

  return {
    users: (usersRes.data || []).map(userFromRow),
    hours: (hoursRes.data || []).map(entryFromRow),
    leave: (leaveRes.data || []).map(entryFromRow),
    holidays: (holidaysRes.data || []).map(h => ({ date: h.date, name: h.name })),
    settings: (settingsRes.data && settingsRes.data.value) || { leaveCountsAsWorked: true, startDate: '2025-01-01' }
  };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id?]
  const resource = parts[1];
  const id = parts[2];

  if (req.method === 'GET' && resource === 'state') {
    const data = await getFullState();
    return sendJSON(res, 200, data);
  }

  if (resource === 'users' && req.method === 'PUT' && id) {
    const body = await readBody(req);
    const update = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.color !== undefined) update.color = body.color;
    if (body.photo !== undefined) update.photo = body.photo;
    if (body.weekNorm !== undefined) update.week_norm = Number(body.weekNorm);
    if (body.leaveHoursPerYear !== undefined) update.leave_hours_per_year = Number(body.leaveHoursPerYear);
    if (body.workdays !== undefined) update.workdays = body.workdays;
    const { data, error } = await supabase.from('uren_users').update(update).eq('id', id).select().maybeSingle();
    if (error) return sendJSON(res, 500, { error: error.message });
    return sendJSON(res, 200, data ? userFromRow(data) : null);
  }

  if (resource === 'hours') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const row = { id: uid(), user_id: body.userId, date: body.date, hours: Number(body.hours), note: body.note || '' };
      const { data, error } = await supabase.from('uren_hours').insert(row).select().single();
      if (error) return sendJSON(res, 500, { error: error.message });
      return sendJSON(res, 200, entryFromRow(data));
    }
    if (req.method === 'PUT' && id) {
      const body = await readBody(req);
      const { data, error } = await supabase.from('uren_hours')
        .update({ date: body.date, hours: Number(body.hours), note: body.note || '' })
        .eq('id', id).select().single();
      if (error) return sendJSON(res, 500, { error: error.message });
      return sendJSON(res, 200, entryFromRow(data));
    }
    if (req.method === 'DELETE' && id) {
      const { error } = await supabase.from('uren_hours').delete().eq('id', id);
      if (error) return sendJSON(res, 500, { error: error.message });
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (resource === 'leave') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const row = { id: uid(), user_id: body.userId, date: body.date, hours: Number(body.hours), note: body.note || '' };
      const { data, error } = await supabase.from('uren_leave').insert(row).select().single();
      if (error) return sendJSON(res, 500, { error: error.message });
      return sendJSON(res, 200, entryFromRow(data));
    }
    if (req.method === 'DELETE' && id) {
      const { error } = await supabase.from('uren_leave').delete().eq('id', id);
      if (error) return sendJSON(res, 500, { error: error.message });
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (resource === 'settings' && req.method === 'PUT') {
    const body = await readBody(req);
    const { data: existing } = await supabase.from('uren_settings').select('value').eq('key', 'app').maybeSingle();
    const current = (existing && existing.value) || {};
    const merged = { ...current, ...body };
    const { error } = await supabase.from('uren_settings')
      .upsert({ key: 'app', value: merged, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) return sendJSON(res, 500, { error: error.message });
    return sendJSON(res, 200, merged);
  }

  if (resource === 'export' && req.method === 'GET') {
    const data = await getFullState();
    const rows = [['type', 'userId', 'userName', 'date', 'hours', 'note']];
    const userById = Object.fromEntries(data.users.map(u => [u.id, u.name]));
    data.hours.forEach(h => rows.push(['uren', h.userId, userById[h.userId] || '', h.date, h.hours, h.note]));
    data.leave.forEach(l => rows.push(['verlof', l.userId, userById[l.userId] || '', l.date, l.hours, l.note]));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="urenregistratie.csv"'
    });
    return res.end(csv);
  }

  sendJSON(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    serveStatic(req, res);
  } catch (err) {
    console.error('Error handling request:', err);
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Uren- en Verlofregistratie Tool draait op http://localhost:${PORT}`);
  console.log(`Database: ${process.env.SUPABASE_URL}`);
});
