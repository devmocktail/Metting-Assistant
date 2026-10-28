'use strict';
(() => {
  const TOKEN_KEY = 'maa_admin_token';
  const $ = (id) => document.getElementById(id);
  const API_BASE = new URL('api/', location.href).href;
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let users = [];
  let filter = 'all';
  let term = '';
  let timer = null;

  // Theme toggle (light/dark), remembered; defaults to the system setting.
  (() => {
    const root = document.documentElement, tg = $('theme-toggle');
    const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4.4"/><path d="M12 1v3M12 20v3M4.2 4.2l2 2M17.8 17.8l2 2M1 12h3M20 12h3M4.2 19.8l2-2M17.8 6.2l2-2"/></svg>';
    const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
    const cur = () => root.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const paint = () => { if (tg) tg.innerHTML = cur() === 'dark' ? SUN : MOON; };
    paint();
    if (tg) tg.addEventListener('click', () => {
      const t = cur() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', t);
      try { localStorage.setItem('a2x-admin-theme', t); } catch (e) { /* ignore */ }
      paint();
    });
  })();

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function toast(msg, ok) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast ' + (ok ? 'ok' : 'err');
    t.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.style.display = 'none'; }, 3500);
  }

  function showGate(err) {
    $('gate').classList.remove('hidden');
    $('app').classList.add('hidden');
    if (err) { $('gate-error').textContent = err; $('gate-error').style.display = 'block'; }
  }
  function showApp() { $('gate').classList.add('hidden'); $('app').classList.remove('hidden'); }

  async function api(path, opts = {}) {
    const res = await fetch(API_BASE + path.replace(/^\//, ''), {
      ...opts,
      headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (res.status === 401) { showGate('Invalid admin token.'); throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  const AV_BG = { approved: '#5fe3ab', pending: '#f3c270', banned: '#ff7a7a', unknown: '#8b929c' };
  function initials(u) {
    const base = (u.name || u.email || '?').trim();
    const parts = base.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || base[0].toUpperCase();
  }
  function fmtTime(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'never';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString();
  }

  function rowHtml(u) {
    const a = [];
    if (u.status !== 'approved') a.push(`<button class="btn primary" data-act="approve" data-email="${esc(u.email)}">Approve</button>`);
    if (u.status !== 'banned') a.push(`<button class="btn" data-act="ban" data-email="${esc(u.email)}">Ban</button>`);
    if (u.status === 'banned') a.push(`<button class="btn" data-act="unban" data-email="${esc(u.email)}">Unban</button>`);
    if (u.device || u.deviceAlert) a.push(`<button class="btn" data-act="reset-device" data-email="${esc(u.email)}">Reset device</button>`);
    a.push(`<button class="btn warn" data-act="uninstall" data-email="${esc(u.email)}">Remove device</button>`);
    a.push(`<button class="btn ghost" data-act="delete" data-email="${esc(u.email)}">Delete</button>`);
    const planTag = u.plan === 'pro' ? '<span class="tag pro">PRO</span>'
      : (u.plan === 'trial' ? '<span class="tag trial">TRIAL</span>' : '');
    const tags = (u.admin ? '<span class="tag admin">ADMIN</span>' : '')
      + planTag
      + (u.command === 'uninstall' ? '<span class="tag removing">REMOVING</span>' : '')
      + (u.deviceAlert ? `<span class="tag removing" title="Another machine${u.deviceAlert.name ? ' (' + esc(u.deviceAlert.name) + ')' : ''} tried to use this account — possible credential sharing">SHARING?</span>` : '');
    // Second line: the real name, plus the bound machine for this account (if any).
    const deviceLine = u.device && u.device.name ? ` · <span class="devname">🖥 ${esc(u.device.name)}</span>` : '';
    return `<tr>
      <td><div class="user">
        <div class="avatar" style="background:${AV_BG[u.status] || AV_BG.unknown}">${esc(initials(u))}</div>
        <div class="uinfo"><div class="email">${esc(u.email)} ${tags}</div><div class="name">${esc(u.name || '—')}${deviceLine}</div></div>
      </div></td>
      <td><span class="badge ${esc(u.status)}">${esc(u.status)}</span></td>
      <td class="when">${esc(fmtTime(u.lastSeenAt))}</td>
      <td><div class="actions">${a.join('')}</div></td>
    </tr>`;
  }

  function renderStats() {
    const c = { approved: 0, pending: 0, banned: 0 };
    users.forEach((u) => { if (c[u.status] !== undefined) c[u.status]++; });
    $('stat-total').textContent = users.length;
    $('stat-approved').textContent = c.approved;
    $('stat-pending').textContent = c.pending;
    $('stat-banned').textContent = c.banned;
  }

  function renderUsers() {
    let list = users;
    if (filter !== 'all') list = list.filter((u) => u.status === filter);
    if (term) list = list.filter((u) => (u.email + ' ' + (u.name || '')).toLowerCase().includes(term));
    $('user-count').textContent = `(${list.length}${list.length !== users.length ? ' of ' + users.length : ''})`;
    $('rows').innerHTML = list.length
      ? list.map(rowHtml).join('')
      : `<tr><td colspan="4" class="empty">${users.length ? 'No users match this filter.' : 'No users yet — sign-ins appear here.'}</td></tr>`;
  }

  // ---- dashboard ----
  const PLAN_PRICE = 999;
  const VIEW_META = {
    dashboard: ['Dashboard', 'Overview of accounts, plans and activity'],
    users: ['Users', 'Approve, ban or remove accounts'],
    activity: ['Activity', 'Recent administrative and billing events'],
  };

  function svgBars(buckets) {
    const w = 520, h = 152, pad = 20, n = buckets.length;
    const max = Math.max(1, ...buckets.map((b) => b.value));
    const bw = (w - pad * 2) / n, barW = Math.min(36, bw * 0.56);
    let out = '';
    buckets.forEach((b, i) => {
      const cx = pad + bw * i + bw / 2;
      const bh = Math.round((h - 46) * (b.value / max));
      const y = h - 26 - bh;
      out += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y}" width="${barW}" height="${Math.max(3, bh)}" rx="5" fill="var(--accent)"></rect>`;
      if (b.value) out += `<text x="${cx}" y="${y - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${b.value}</text>`;
      out += `<text x="${cx}" y="${h - 8}" text-anchor="middle" font-size="10.5" fill="var(--faint)">${b.label}</text>`;
    });
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">${out}</svg>`;
  }

  function svgDonut(segs) {
    const total = segs.reduce((s, x) => s + x.value, 0) || 1;
    const r = 52, c = 2 * Math.PI * r, cx = 70, cy = 70, sum = segs.reduce((s, x) => s + x.value, 0);
    let off = 0, arcs = '';
    segs.forEach((s) => {
      const len = (s.value / total) * c;
      if (s.value > 0) arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
      off += len;
    });
    return `<svg viewBox="0 0 140 140" style="width:140px;max-width:100%;height:auto;display:block;margin:4px auto 0">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--tint-2)" stroke-width="18"></circle>${arcs}
      <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="26" font-weight="800" fill="var(--fg)">${sum}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="10.5" fill="var(--faint)">accounts</text></svg>`;
  }

  function renderDashboard() {
    const pro = users.filter((u) => u.plan === 'pro').length;
    const trial = users.filter((u) => u.plan === 'trial').length;
    const other = Math.max(0, users.length - pro - trial);
    const active = users.filter((u) => u.lastSeenAt && (Date.now() - new Date(u.lastSeenAt).getTime()) < 86400000).length;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('stat-pro', pro); set('stat-trial', trial); set('stat-active', active);
    set('stat-mrr', '₹' + (pro * PLAN_PRICE).toLocaleString('en-IN'));

    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], days = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); days.push({ label: dow[d.getDay()], key: d.toDateString(), value: 0 }); }
    users.forEach((u) => {
      if (!u.createdAt) return;
      const k = new Date(u.createdAt); if (Number.isNaN(k.getTime())) return;
      k.setHours(0, 0, 0, 0);
      const b = days.find((x) => x.key === k.toDateString()); if (b) b.value++;
    });
    if ($('chart-signups')) $('chart-signups').innerHTML = svgBars(days);

    const segs = [
      { label: 'Pro', value: pro, color: 'var(--accent)' },
      { label: 'Trial', value: trial, color: 'var(--amber)' },
      { label: 'Other', value: other, color: 'var(--blue)' },
    ];
    if ($('chart-plans')) $('chart-plans').innerHTML = svgDonut(segs);
    if ($('plans-legend')) $('plans-legend').innerHTML = segs.map((s) => `<span class="li"><span class="sw" style="background:${s.color}"></span>${s.label} <b>${s.value}</b></span>`).join('');

    if ($('dash-latest')) {
      const latest = users.filter((u) => u.createdAt).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5);
      $('dash-latest').innerHTML = latest.length ? latest.map((u) => `<div class="mini-row">
        <div class="avatar" style="background:${AV_BG[u.status] || AV_BG.unknown}">${esc(initials(u))}</div>
        <div class="mi"><div class="e">${esc(u.email)}</div><div class="t">${esc(u.plan || '—')} · ${esc(fmtTime(u.createdAt))}</div></div>
        <span class="badge ${esc(u.status)}">${esc(u.status)}</span></div>`).join('') : '<div class="mini-row" style="color:var(--faint)">No sign-ups yet.</div>';
    }
  }

  function switchView(view) {
    ['dashboard', 'users', 'activity'].forEach((v) => { const el = $('view-' + v); if (el) el.hidden = v !== view; });
    document.querySelectorAll('.navitem').forEach((n) => n.classList.toggle('on', n.dataset.view === view));
    const meta = VIEW_META[view] || VIEW_META.dashboard;
    if ($('view-title')) $('view-title').textContent = meta[0];
    if ($('view-sub')) $('view-sub').textContent = meta[1];
  }

  async function loadUsers() {
    const r = await api('/users');
    users = r.users || [];
    renderStats();
    renderUsers();
    renderDashboard();
  }
  async function loadAudit() {
    const { audit } = await api('/audit?limit=120');
    $('audit').textContent = audit.length
      ? audit.map((x) => `${x.ts.slice(0, 19).replace('T', ' ')}  ${x.actor}  ${x.action}  ${x.target}${x.detail ? '  (' + x.detail + ')' : ''}`).join('\n')
      : '—';
  }
  async function loadConfig() {
    try { const cfg = await api('/config'); $('mode-text').textContent = 'auth: ' + cfg.authMode; } catch { /* handled */ }
  }
  async function refresh() { try { await Promise.all([loadUsers(), loadAudit()]); } catch { /* shown */ } }

  async function act(email, action) {
    try {
      if (action === 'delete') {
        if (!confirm(`Delete ${email}? This removes the record entirely.`)) return;
        await api('/users/' + encodeURIComponent(email), { method: 'DELETE' });
      } else if (action === 'uninstall') {
        if (!confirm(`Remove the tool from ${email}'s computer?\n\nTheir app uninstalls itself on its next check-in (~2 min) and loses access now. Approving them again cancels it.`)) return;
        await api('/users/' + encodeURIComponent(email) + '/uninstall', { method: 'POST', body: '{}' });
      } else if (action === 'reset-device') {
        if (!confirm(`Reset the bound device for ${email}?\n\nUse this when they switch to a new computer. The next computer they sign in on becomes their device.`)) return;
        await api('/users/' + encodeURIComponent(email) + '/reset-device', { method: 'POST', body: '{}' });
      } else {
        await api('/users/' + encodeURIComponent(email) + '/' + action, { method: 'POST', body: '{}' });
      }
      toast(`${action} → ${email}`, true);
      await loadUsers();
      loadAudit();
    } catch (e) { toast(e.message, false); }
  }

  // --- wiring ---
  $('token-save').addEventListener('click', async () => {
    token = $('token-input').value.trim();
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    try { await loadConfig(); showApp(); refresh(); } catch { /* gate */ }
  });
  $('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('token-save').click(); });
  $('signout-btn').addEventListener('click', () => { localStorage.removeItem(TOKEN_KEY); token = ''; showGate(); });
  document.querySelectorAll('.navitem').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));
  $('refresh-btn').addEventListener('click', refresh);
  $('search').addEventListener('input', (e) => { term = e.target.value.trim().toLowerCase(); renderUsers(); });
  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    [...$('filters').children].forEach((x) => x.classList.toggle('on', x === b));
    renderUsers();
  });
  $('add-btn').addEventListener('click', async () => {
    const email = $('add-email').value.trim().toLowerCase();
    if (!email) return;
    try {
      await api('/users', { method: 'POST', body: JSON.stringify({ email, status: $('add-status').value }) });
      $('add-email').value = '';
      toast(`added ${email}`, true);
      await loadUsers();
      loadAudit();
    } catch (e) { toast(e.message, false); }
  });
  $('add-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add-btn').click(); });
  $('rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b) act(b.dataset.email, b.dataset.act);
  });

  if (timer) clearInterval(timer);
  timer = setInterval(() => { if ($('auto').checked && !$('app').classList.contains('hidden')) refresh(); }, 10000);

  if (token) { loadConfig().then(showApp).then(refresh).catch(() => showGate()); }
  else { showGate(); }
})();
