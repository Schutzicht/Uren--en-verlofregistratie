const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { persistSession: false } }
);

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

/**
 * Generic API handler. Takes method + path parts + body and returns
 * { status, body, headers } so it works in Node's http or Vercel.
 */
async function handleApiRequest(method, pathParts, body) {
  // pathParts = ['api', resource, id?]  or ['resource', id?]
  const start = pathParts[0] === 'api' ? 1 : 0;
  const resource = pathParts[start];
  const id = pathParts[start + 1];

  if (method === 'GET' && resource === 'state') {
    const data = await getFullState();
    return { status: 200, body: data };
  }

  if (resource === 'users' && method === 'PUT' && id) {
    const update = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.color !== undefined) update.color = body.color;
    if (body.photo !== undefined) update.photo = body.photo;
    if (body.weekNorm !== undefined) update.week_norm = Number(body.weekNorm);
    if (body.leaveHoursPerYear !== undefined) update.leave_hours_per_year = Number(body.leaveHoursPerYear);
    if (body.workdays !== undefined) update.workdays = body.workdays;
    const { data, error } = await supabase.from('uren_users').update(update).eq('id', id).select().maybeSingle();
    if (error) return { status: 500, body: { error: error.message } };
    return { status: 200, body: data ? userFromRow(data) : null };
  }

  if (resource === 'hours') {
    if (method === 'POST') {
      const row = { id: uid(), user_id: body.userId, date: body.date, hours: Number(body.hours), note: body.note || '' };
      const { data, error } = await supabase.from('uren_hours').insert(row).select().single();
      if (error) return { status: 500, body: { error: error.message } };
      return { status: 200, body: entryFromRow(data) };
    }
    if (method === 'PUT' && id) {
      const { data, error } = await supabase.from('uren_hours')
        .update({ date: body.date, hours: Number(body.hours), note: body.note || '' })
        .eq('id', id).select().single();
      if (error) return { status: 500, body: { error: error.message } };
      return { status: 200, body: entryFromRow(data) };
    }
    if (method === 'DELETE' && id) {
      const { error } = await supabase.from('uren_hours').delete().eq('id', id);
      if (error) return { status: 500, body: { error: error.message } };
      return { status: 200, body: { ok: true } };
    }
  }

  if (resource === 'leave') {
    if (method === 'POST') {
      const row = { id: uid(), user_id: body.userId, date: body.date, hours: Number(body.hours), note: body.note || '' };
      const { data, error } = await supabase.from('uren_leave').insert(row).select().single();
      if (error) return { status: 500, body: { error: error.message } };
      return { status: 200, body: entryFromRow(data) };
    }
    if (method === 'DELETE' && id) {
      const { error } = await supabase.from('uren_leave').delete().eq('id', id);
      if (error) return { status: 500, body: { error: error.message } };
      return { status: 200, body: { ok: true } };
    }
  }

  if (resource === 'settings' && method === 'PUT') {
    const { data: existing } = await supabase.from('uren_settings').select('value').eq('key', 'app').maybeSingle();
    const current = (existing && existing.value) || {};
    const merged = { ...current, ...body };
    const { error } = await supabase.from('uren_settings')
      .upsert({ key: 'app', value: merged, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) return { status: 500, body: { error: error.message } };
    return { status: 200, body: merged };
  }

  if (resource === 'export' && method === 'GET') {
    const data = await getFullState();
    const rows = [['type', 'userId', 'userName', 'date', 'hours', 'note']];
    const userById = Object.fromEntries(data.users.map(u => [u.id, u.name]));
    data.hours.forEach(h => rows.push(['uren', h.userId, userById[h.userId] || '', h.date, h.hours, h.note]));
    data.leave.forEach(l => rows.push(['verlof', l.userId, userById[l.userId] || '', l.date, l.hours, l.note]));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    return {
      status: 200,
      body: csv,
      isRaw: true,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="urenregistratie.csv"'
      }
    };
  }

  return { status: 404, body: { error: 'Unknown endpoint' } };
}

module.exports = { handleApiRequest };
