const state = {
  users: [],
  hours: [],
  leave: [],
  holidays: [],
  settings: {},
  meId: localStorage.getItem('meId') || null,
  viewUserId: localStorage.getItem('viewUserId') || null
};

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (!res.ok) throw new Error('API error');
  return res.json();
}

async function loadState() {
  const data = await api('/api/state');
  state.users = data.users;
  state.hours = data.hours;
  state.leave = data.leave;
  state.holidays = data.holidays || [];
  state.settings = data.settings;
  if (!state.meId || !state.users.find(u => u.id === state.meId)) {
    state.meId = state.users[0].id;
    localStorage.setItem('meId', state.meId);
  }
  if (!state.viewUserId || !state.users.find(u => u.id === state.viewUserId)) {
    state.viewUserId = state.meId;
    localStorage.setItem('viewUserId', state.viewUserId);
  }
  render();
}

function isReadOnly() { return state.viewUserId !== state.meId; }
function meUser() { return state.users.find(u => u.id === state.meId); }

// --- Date helpers ---
function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }
function today() { return isoDate(new Date()); }
function getWeekKey(dateStr) {
  const d = new Date(dateStr);
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  const weekNr = 1 + Math.ceil((firstThursday - target) / 604800000);
  return `${d.getFullYear()}-W${String(weekNr).padStart(2, '0')}`;
}
function getMondayOfWeek(dateStr) {
  const d = new Date(dateStr);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return isoDate(d);
}
function weeksBetween(startStr, endStr) {
  const s = new Date(getMondayOfWeek(startStr));
  const e = new Date(getMondayOfWeek(endStr));
  return Math.max(1, Math.round((e - s) / (7 * 86400000)) + 1);
}
function currentYear() { return new Date().getFullYear(); }

// --- Business logic ---
function currentUser() { return state.users.find(u => u.id === state.viewUserId); }
function hoursForUser(userId) { return state.hours.filter(h => h.userId === userId); }
function leaveForUser(userId) { return state.leave.filter(l => l.userId === userId); }

// Standard workday = 8 hours (ongeacht weeknorm of deeltijd)
function dailyQuota(user) {
  return 8;
}

// Holidays that fall on this user's workdays in a given week
function holidayCreditForWeek(userId, weekKey) {
  const user = state.users.find(u => u.id === userId);
  const workdays = user.workdays || [1, 2, 3, 4, 5];
  const quota = dailyQuota(user);
  let credit = 0;
  state.holidays.forEach(h => {
    if (getWeekKey(h.date) !== weekKey) return;
    const dow = new Date(h.date).getDay(); // 0=zo, 1=ma...
    if (workdays.includes(dow)) credit += quota;
  });
  return credit;
}

function holidaysInWeek(userId, weekKey) {
  const user = state.users.find(u => u.id === userId);
  const workdays = user.workdays || [1, 2, 3, 4, 5];
  return state.holidays.filter(h => {
    if (getWeekKey(h.date) !== weekKey) return false;
    const dow = new Date(h.date).getDay();
    return workdays.includes(dow);
  });
}

// Actually-logged hours only
function weekHoursLogged(userId, weekKey) {
  let total = 0;
  hoursForUser(userId).forEach(h => { if (getWeekKey(h.date) === weekKey) total += Number(h.hours); });
  return total;
}
// Effective hours including leave + holidays (used for norm comparison + saldo)
function weekHours(userId, weekKey) {
  let total = weekHoursLogged(userId, weekKey);
  if (state.settings.leaveCountsAsWorked) {
    leaveForUser(userId).forEach(l => { if (getWeekKey(l.date) === weekKey) total += Number(l.hours); });
  }
  total += holidayCreditForWeek(userId, weekKey);
  return total;
}
function computeSaldo(userId) {
  const user = state.users.find(u => u.id === userId);
  const start = state.settings.startDate || today();
  const startMonday = getMondayOfWeek(start);
  const currentMonday = getMondayOfWeek(today());
  const currentWeek = getWeekKey(today());
  let saldo = 0;
  // Iterate week by week from start through current week
  const d = new Date(startMonday);
  while (isoDate(d) <= currentMonday) {
    const wk = getWeekKey(isoDate(d));
    const wh = weekHours(userId, wk);
    if (wk === currentWeek) {
      // Lopende week: alleen overwerk telt mee in saldo (geen straf voor onafgeronde week)
      if (wh > user.weekNorm) saldo += wh - user.weekNorm;
    } else {
      // Afgeronde week: volledige diff
      saldo += wh - user.weekNorm;
    }
    d.setDate(d.getDate() + 7);
  }
  return saldo;
}
function leaveUsedThisYear(userId) {
  const year = currentYear();
  return leaveForUser(userId).filter(l => new Date(l.date).getFullYear() === year).reduce((a, l) => a + Number(l.hours), 0);
}

// Effectief verlofbudget voor dit jaar: pro-rata in het eerste jaar
// (vanaf startDate tot eind dec), volledig in volgende jaren.
function effectiveLeaveHours(user) {
  const year = currentYear();
  const fullYear = Number(user.leaveHoursPerYear) || 0;
  const startDate = state.settings.startDate;
  if (!startDate) return fullYear;
  const startYear = new Date(startDate).getFullYear();
  if (year > startYear) return fullYear;
  if (year < startYear) return 0;
  // Zelfde jaar als startDate → pro-rata op weken
  const startMonday = new Date(getMondayOfWeek(startDate));
  const yearEnd = new Date(year, 11, 31);
  const weeksRemaining = Math.max(1, Math.ceil((yearEnd - startMonday) / (7 * 86400000)));
  const weeksTotal = 52;
  return Math.round(fullYear * Math.min(1, weeksRemaining / weeksTotal));
}
function fmt(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(1).replace(/\.0$/, ''); }
function fmtU(n) { return Number(n).toFixed(1).replace(/\.0$/, ''); }

// --- Rendering ---
function render() {
  renderUserSwitch();
  renderViewBar();
  renderHero();
  renderDashboard();
  renderInvoer();
  renderVerlof();
  renderTeam();
  renderSettings();
  document.body.classList.toggle('readonly', isReadOnly());
  $('#year').textContent = new Date().getFullYear();
}

function renderHero() {
  const u = currentUser();
  const me = meUser();
  if (!u) return;
  if (isReadOnly()) {
    $('#heroName').textContent = u.name;
    $('#heroIntro').textContent = `Bekijken — ${u.name} staat er zo voor:`;
  } else {
    $('#heroName').textContent = me.name;
    $('#heroIntro').textContent = `Hey,`;
  }
}

function renderUserSwitch() {
  const el = $('#userSwitch');
  el.innerHTML = '<span class="login-label">Ingelogd als</span>';
  state.users.forEach(u => {
    const btn = document.createElement('button');
    btn.innerHTML = `<img src="${u.photo}" alt="${u.name}" /><span>${u.name}</span>`;
    if (u.id === state.meId) {
      btn.classList.add('active');
      btn.style.background = u.color;
      btn.style.borderColor = u.color;
    }
    btn.onclick = () => {
      state.meId = u.id;
      state.viewUserId = u.id;
      localStorage.setItem('meId', u.id);
      localStorage.setItem('viewUserId', u.id);
      render();
    };
    el.appendChild(btn);
  });
}

function renderViewBar() {
  const el = $('#viewBar');
  if (!el) return;
  el.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'view-label';
  label.textContent = 'Bekijken:';
  el.appendChild(label);
  state.users.forEach(u => {
    const btn = document.createElement('button');
    btn.className = 'view-pill';
    btn.innerHTML = `<img src="${u.photo}" alt="${u.name}" /><span>${u.name}</span>`;
    btn.style.setProperty('--user-color', u.color);
    if (u.id === state.viewUserId) {
      btn.classList.add('active');
      btn.style.borderColor = u.color;
      btn.style.color = u.color;
    }
    btn.onclick = () => {
      state.viewUserId = u.id;
      localStorage.setItem('viewUserId', u.id);
      render();
    };
    el.appendChild(btn);
  });

  // Read-only banner
  const banner = $('#readOnlyBanner');
  const u = currentUser();
  if (isReadOnly()) {
    banner.style.display = 'flex';
    banner.style.borderColor = u.color;
    banner.innerHTML = `
      <span class="ro-dot" style="background:${u.color}"></span>
      <span>Je bekijkt het dashboard van <strong>${escapeHtml(u.name)}</strong> — alleen-lezen. Wissel terug naar jezelf om te bewerken.</span>`;
  } else {
    banner.style.display = 'none';
  }

  // Color the page accent based on viewed user
  document.documentElement.style.setProperty('--user-accent', u.color);
}

function renderDashboard() {
  const u = currentUser();
  if (!u) return;
  const thisWeek = getWeekKey(today());
  const wh = weekHours(u.id, thisWeek);
  $('#dbWeekHours').textContent = fmtU(wh);
  const diff = wh - u.weekNorm;
  const diffEl = $('#dbWeekDiff');
  diffEl.innerHTML = `${fmt(diff)}<span class="suffix">u</span>`;

  const saldo = computeSaldo(u.id);
  $('#dbSaldo').innerHTML = `${fmt(saldo)}<span class="suffix">u</span>`;

  const used = leaveUsedThisYear(u.id);
  const effectiveLeave = effectiveLeaveHours(u);
  $('#dbLeaveLeft').textContent = fmtU(effectiveLeave - used);

  // Week chart — last 8 weeks
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    weeks.push(getWeekKey(isoDate(d)));
  }
  const wc = $('#weekChart');
  wc.innerHTML = '';
  const max = Math.max(u.weekNorm * 1.3, ...weeks.map(w => weekHours(u.id, w)), 1);
  weeks.forEach(w => {
    const h = weekHours(u.id, w);
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.background = u.color;
    bar.style.height = (h / max * 100) + '%';
    bar.innerHTML = `<span class="bar-value">${h.toFixed(0)}</span><span class="bar-label">${w.slice(5)}</span>`;
    wc.appendChild(bar);
  });

  // Pie chart (leave used vs remaining)
  renderLeavePie(u);

  // Recent list
  const recent = [...hoursForUser(u.id).map(h => ({ ...h, type: 'uren' })),
                  ...leaveForUser(u.id).map(l => ({ ...l, type: 'verlof' }))]
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const rl = $('#recentList');
  rl.innerHTML = '';
  if (recent.length === 0) {
    rl.innerHTML = '<li style="color:var(--text-secondary);font-style:italic;border:none;justify-content:center;">Nog geen entries — voeg je eerste uren toe via het tabblad "Uren invoeren"</li>';
  }
  recent.forEach(e => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${fmtU(e.hours)} u</strong>${e.type === 'verlof' ? '<span class="entry-badge leave">Verlof</span>' : ''}
        ${e.note ? `<div class="entry-note">${escapeHtml(e.note)}</div>` : ''}
      </div>
      <div class="entry-meta">${e.date}</div>`;
    rl.appendChild(li);
  });
}

function renderLeavePie(u) {
  const used = leaveUsedThisYear(u.id);
  const total = effectiveLeaveHours(u);
  const pct = total > 0 ? Math.min(1, used / total) : 0;

  const svg = $('#leavePie');
  svg.innerHTML = '';
  const cx = 100, cy = 100, r = 70;
  const C = 2 * Math.PI * r;

  // Background track
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bg.setAttribute('cx', cx);
  bg.setAttribute('cy', cy);
  bg.setAttribute('r', r);
  bg.setAttribute('class', 'pie-slice');
  bg.setAttribute('stroke', 'var(--warm-grey)');
  svg.appendChild(bg);

  // Foreground arc
  if (pct > 0) {
    const fg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    fg.setAttribute('cx', cx);
    fg.setAttribute('cy', cy);
    fg.setAttribute('r', r);
    fg.setAttribute('class', 'pie-slice');
    fg.setAttribute('stroke', u.color);
    fg.setAttribute('stroke-linecap', 'round');
    fg.setAttribute('stroke-dasharray', `${C * pct} ${C}`);
    fg.style.transition = 'stroke-dasharray 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
    svg.appendChild(fg);
  }

  $('#pieUsed').textContent = Math.round(used);
  $('#pieTotal').textContent = total;
}

function renderInvoer() {
  const u = currentUser();
  if (!u) return;
  if (!$('#hDate').value) $('#hDate').value = today();

  // Week summary — last 6 weeks
  const summary = $('#weekSummary');
  summary.innerHTML = '';
  const weeks = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    weeks.push(getWeekKey(isoDate(d)));
  }
  weeks.forEach(w => {
    const h = weekHours(u.id, w);
    const logged = weekHoursLogged(u.id, w);
    const credit = h - logged;
    const diff = h - u.weekNorm;
    const hols = holidaysInWeek(u.id, w);
    const row = document.createElement('div');
    row.className = 'week-summary-row';
    row.innerHTML = `
      <span class="wk">${w}${hols.length ? ` <span class="holiday-tag" title="${hols.map(h=>h.name).join(', ')}">🎉 ${hols.length}</span>` : ''}</span>
      <span>${fmtU(logged)}${credit > 0 ? ` <span class="credit-tag">+${fmtU(credit)}</span>` : ''} / ${u.weekNorm} u
        <strong class="${diff >= 0 ? 'pos' : 'neg'}">(${fmt(diff)})</strong>
      </span>`;
    summary.appendChild(row);
  });

  // Hours entries
  const list = $('#hoursList');
  list.innerHTML = '';
  const entries = hoursForUser(u.id).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  if (entries.length === 0) {
    list.innerHTML = '<li style="color:var(--text-secondary);font-style:italic;border:none;justify-content:center;">Nog geen uren ingevoerd</li>';
  }
  entries.forEach(e => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${fmtU(e.hours)} u</strong>
        <span class="entry-meta"> — ${e.date}</span>
        ${e.note ? `<div class="entry-note">${escapeHtml(e.note)}</div>` : ''}
      </div>
      <button class="del-btn" data-id="${e.id}">Verwijder</button>`;
    list.appendChild(li);
  });
  list.querySelectorAll('.del-btn').forEach(b => {
    b.onclick = async () => {
      await api('/api/hours/' + b.dataset.id, { method: 'DELETE' });
      await loadState();
    };
  });
}

function renderVerlof() {
  const u = currentUser();
  if (!u) return;
  if (!$('#lDate').value) $('#lDate').value = today();
  const used = leaveUsedThisYear(u.id);
  const effectiveLeave = effectiveLeaveHours(u);
  $('#vTotal').textContent = effectiveLeave;
  $('#vUsed').textContent = Math.round(used);
  $('#vLeft').textContent = Math.round(effectiveLeave - used);

  const list = $('#leaveList');
  list.innerHTML = '';
  const entries = leaveForUser(u.id).slice().sort((a, b) => b.date.localeCompare(a.date));
  if (entries.length === 0) {
    list.innerHTML = '<li style="color:var(--text-secondary);font-style:italic;border:none;justify-content:center;">Nog geen verlof opgenomen</li>';
  }
  entries.forEach(e => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${fmtU(e.hours)} u</strong>
        <span class="entry-meta"> — ${e.date}</span>
        ${e.note ? `<div class="entry-note">${escapeHtml(e.note)}</div>` : ''}
      </div>
      <button class="del-btn" data-id="${e.id}">Verwijder</button>`;
    list.appendChild(li);
  });
  list.querySelectorAll('.del-btn').forEach(b => {
    b.onclick = async () => {
      await api('/api/leave/' + b.dataset.id, { method: 'DELETE' });
      await loadState();
    };
  });
}

function renderTeam() {
  const thisWeek = getWeekKey(today());

  // Team cards
  const grid = $('#teamGrid');
  grid.innerHTML = '';
  state.users.forEach(u => {
    const wh = weekHours(u.id, thisWeek);
    const saldo = computeSaldo(u.id);
    const leaveLeft = effectiveLeaveHours(u) - leaveUsedThisYear(u.id);
    const card = document.createElement('div');
    card.className = 'team-card';
    card.style.color = u.color;
    card.style.cursor = 'pointer';
    if (u.id === state.viewUserId) card.classList.add('viewing');
    if (u.id === state.meId) card.classList.add('me');
    card.onclick = () => {
      state.viewUserId = u.id;
      localStorage.setItem('viewUserId', u.id);
      $$('.tab').forEach(x => x.classList.remove('active'));
      $$('.panel').forEach(x => x.classList.remove('active'));
      $('[data-tab="dashboard"]').classList.add('active');
      $('#tab-dashboard').classList.add('active');
      render();
    };
    card.innerHTML = `
      <img src="${u.photo}" alt="${u.name}" class="team-card-photo" />
      <div class="team-card-name" style="color:var(--text)">${u.name}${u.id === state.meId ? ' <span class="me-tag">jij</span>' : ''}</div>
      <div class="team-card-role">Vennoot</div>
      <div class="team-card-stats">
        <div class="team-card-stat">
          <div class="team-card-stat-value" style="color:var(--text)">${fmtU(wh)}</div>
          <div class="team-card-stat-label">Deze week</div>
        </div>
        <div class="team-card-stat">
          <div class="team-card-stat-value ${saldo >= 0 ? 'pos' : 'neg'}">${fmt(saldo)}</div>
          <div class="team-card-stat-label">Saldo</div>
        </div>
        <div class="team-card-stat">
          <div class="team-card-stat-value" style="color:var(--text)">${u.weekNorm}</div>
          <div class="team-card-stat-label">Weeknorm</div>
        </div>
        <div class="team-card-stat">
          <div class="team-card-stat-value" style="color:var(--text)">${Math.round(leaveLeft)}</div>
          <div class="team-card-stat-label">Verlof over</div>
        </div>
      </div>`;
    grid.appendChild(card);
  });

  // Grouped chart
  const chart = $('#teamChart');
  chart.innerHTML = '';
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    weeks.push(getWeekKey(isoDate(d)));
  }
  const allVals = state.users.flatMap(u => weeks.map(w => weekHours(u.id, w)));
  const max = Math.max(...allVals, 1);
  weeks.forEach(w => {
    const group = document.createElement('div');
    group.className = 'bar-group';
    state.users.forEach(u => {
      const h = weekHours(u.id, w);
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.background = u.color;
      bar.style.height = (h / max * 100) + '%';
      bar.title = `${u.name}: ${fmtU(h)} u`;
      group.appendChild(bar);
    });
    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = w.slice(5);
    group.appendChild(label);
    chart.appendChild(group);
  });

  // Legend
  const legend = $('#teamLegend');
  legend.innerHTML = '';
  state.users.forEach(u => {
    const d = document.createElement('div');
    d.innerHTML = `<span class="dot" style="background:${u.color}"></span>${u.name}`;
    legend.appendChild(d);
  });

  // Saldo bars
  const saldoBars = $('#teamSaldoBars');
  saldoBars.innerHTML = '';
  const saldos = state.users.map(u => ({ u, saldo: computeSaldo(u.id) }));
  const absMax = Math.max(...saldos.map(s => Math.abs(s.saldo)), 20);
  saldos.forEach(({ u, saldo }) => {
    const row = document.createElement('div');
    row.className = 'saldo-row';
    const pct = Math.abs(saldo) / absMax * 50;
    const left = saldo >= 0 ? 50 : 50 - pct;
    row.innerHTML = `
      <div class="saldo-name"><img src="${u.photo}" />${u.name}</div>
      <div class="saldo-track">
        <div style="position:absolute;left:50%;top:-4px;bottom:-4px;width:1px;background:var(--warm-grey);"></div>
        <div class="saldo-fill" style="left:${left}%;width:${pct}%;background:${saldo >= 0 ? u.color : 'var(--bad)'};"></div>
      </div>
      <div class="saldo-value ${saldo >= 0 ? 'pos' : 'neg'}">${fmt(saldo)}u</div>`;
    saldoBars.appendChild(row);
  });
}

function renderSettings() {
  const us = $('#userSettings');
  us.innerHTML = '';
  const dayLabels = ['Z', 'M', 'D', 'W', 'D', 'V', 'Z'];
  state.users.forEach(u => {
    const div = document.createElement('div');
    div.className = 'user-edit';
    const wd = u.workdays || [1,2,3,4,5];
    const dayBtns = [1,2,3,4,5,6,0].map(d =>
      `<button type="button" class="day-btn ${wd.includes(d) ? 'on' : ''}" data-id="${u.id}" data-day="${d}">${dayLabels[d]}</button>`
    ).join('');
    div.innerHTML = `
      <img src="${u.photo}" alt="${u.name}" />
      <div>
        <label>Naam</label>
        <input type="text" data-id="${u.id}" data-field="name" value="${escapeHtml(u.name)}" />
      </div>
      <div>
        <label>Weeknorm (u)</label>
        <input type="number" data-id="${u.id}" data-field="weekNorm" value="${u.weekNorm}" />
      </div>
      <div>
        <label>Verlof vol jaar (u)</label>
        <input type="number" data-id="${u.id}" data-field="leaveHoursPerYear" value="${u.leaveHoursPerYear}" title="Volledig jaarmaximum. Eerste jaar wordt automatisch pro-rata berekend vanaf startdatum." />
      </div>
      <div class="workdays-field">
        <label>Vaste werkdagen</label>
        <div class="day-row">${dayBtns}</div>
      </div>`;
    us.appendChild(div);
  });

  // Day toggles
  us.querySelectorAll('.day-btn').forEach(btn => {
    btn.onclick = () => {
      if (isReadOnly()) return;
      const u = state.users.find(x => x.id === btn.dataset.id);
      const day = Number(btn.dataset.day);
      u.workdays = u.workdays || [1,2,3,4,5];
      if (u.workdays.includes(day)) u.workdays = u.workdays.filter(d => d !== day);
      else u.workdays = [...u.workdays, day].sort();
      btn.classList.toggle('on');
    };
  });

  $('#setStart').value = state.settings.startDate || today();
  $('#setLeaveCounts').checked = !!state.settings.leaveCountsAsWorked;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Event bindings ---
function initTabs() {
  $$('.tab').forEach(t => {
    t.onclick = () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      $$('.panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('#tab-' + t.dataset.tab).classList.add('active');
    };
  });
}

function initForms() {
  $('#hoursForm').onsubmit = async e => {
    e.preventDefault();
    await api('/api/hours', {
      method: 'POST',
      body: JSON.stringify({
        userId: state.meId,
        date: $('#hDate').value,
        hours: $('#hHours').value,
        note: $('#hNote').value
      })
    });
    $('#hHours').value = '';
    $('#hNote').value = '';
    await loadState();
  };

  $('#leaveForm').onsubmit = async e => {
    e.preventDefault();
    await api('/api/leave', {
      method: 'POST',
      body: JSON.stringify({
        userId: state.meId,
        date: $('#lDate').value,
        hours: $('#lHours').value,
        note: $('#lNote').value
      })
    });
    $('#lHours').value = '';
    $('#lNote').value = '';
    await loadState();
  };

  $('#saveSettings').onclick = async () => {
    const inputs = $$('#userSettings input');
    const updates = {};
    inputs.forEach(i => {
      updates[i.dataset.id] = updates[i.dataset.id] || {};
      updates[i.dataset.id][i.dataset.field] = i.type === 'number' ? Number(i.value) : i.value;
    });
    // Include workdays from in-memory state (toggled via day-btn)
    state.users.forEach(u => {
      updates[u.id] = updates[u.id] || {};
      updates[u.id].workdays = u.workdays || [1,2,3,4,5];
    });
    for (const id in updates) {
      await api('/api/users/' + id, { method: 'PUT', body: JSON.stringify(updates[id]) });
    }
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        startDate: $('#setStart').value,
        leaveCountsAsWorked: $('#setLeaveCounts').checked
      })
    });
    await loadState();
  };
}

initTabs();
initForms();
loadState();
