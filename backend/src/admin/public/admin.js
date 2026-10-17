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

  const AV_BG = { approved: '#50dea3', pending: '#e0a63a', banned: '#ff6b6b', unknown: '#8b929c' };
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
    a.push(`<button class="btn warn" data-act="uninstall" data-email="${esc(u.email)}">Remove device</button>`);
    a.push(`<button class="btn ghost" data-act="delete" data-email="${esc(u.email)}">Delete</button>`);
    const tags = (u.admin ? '<span class="tag admin">ADMIN</span>' : '')
      + (u.command === 'uninstall' ? '<span class="tag removing">REMOVING</span>' : '');
    return `<tr>
      <td><div class="user">
        <div class="avatar" style="background:${AV_BG[u.status] || AV_BG.unknown}">${esc(initials(u))}</div>
        <div class="uinfo"><div class="email">${esc(u.email)} ${tags}</div><div class="name">${esc(u.name || '—')}</div></div>
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

  async function loadUsers() {
    const r = await api('/users');
    users = r.users || [];
    renderStats();
    renderUsers();
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
