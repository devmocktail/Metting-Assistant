'use strict';
(() => {
  const TOKEN_KEY = 'maa_admin_token';
  const $ = (id) => document.getElementById(id);
  // API base is relative to this page, so it works at a domain root or in a subfolder.
  const API_BASE = new URL('api/', location.href).href;
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let timer = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function showGate(msg) {
    $('gate').classList.remove('hidden');
    $('app').classList.add('hidden');
    if (msg) { $('gate-notice').textContent = msg; $('gate-notice').style.display = 'block'; }
  }
  function showApp() {
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
  }
  function notify(msg, ok) {
    const n = $('notice');
    n.textContent = msg;
    n.style.display = msg ? 'block' : 'none';
    n.style.color = ok ? 'var(--green)' : '#ffb4b4';
    n.style.background = ok ? '#0f2118' : '#241216';
    n.style.borderColor = ok ? '#1c4' : '#502';
    if (msg) setTimeout(() => { n.style.display = 'none'; }, 4000);
  }

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

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }

  function userRow(u) {
    const actions = [];
    if (u.status !== 'approved') actions.push(`<button class="primary" data-act="approve" data-email="${esc(u.email)}">Approve</button>`);
    if (u.status !== 'banned') actions.push(`<button class="danger" data-act="ban" data-email="${esc(u.email)}">Ban</button>`);
    if (u.status === 'banned') actions.push(`<button data-act="unban" data-email="${esc(u.email)}">Unban</button>`);
    if (u.status !== 'pending') actions.push(`<button class="ghost" data-act="pending" data-email="${esc(u.email)}">Set pending</button>`);
    actions.push(`<button class="danger" data-act="uninstall" data-email="${esc(u.email)}">Remove device</button>`);
    actions.push(`<button class="ghost" data-act="delete" data-email="${esc(u.email)}">Delete</button>`);
    const admintag = u.admin ? '<span class="admintag">ADMIN</span>' : '';
    const removing = u.command === 'uninstall' ? ' <span class="badge banned">REMOVING</span>' : '';
    return `<tr>
      <td><div class="email">${esc(u.email)}${admintag}</div><div class="sub">${esc(u.name || '')}</div></td>
      <td><span class="badge ${esc(u.status)}">${esc(u.status)}</span>${removing}</td>
      <td class="sub">${fmtTime(u.lastSeenAt)}</td>
      <td><div class="actions">${actions.join('')}</div></td>
    </tr>`;
  }

  async function loadUsers() {
    const { users } = await api('/users');
    $('count-pill').textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;
    $('users-body').innerHTML = users.length
      ? users.map(userRow).join('')
      : '<tr><td colspan="4" class="muted">No users yet. Sign-ins will appear here.</td></tr>';
  }

  async function loadAudit() {
    const { audit } = await api('/audit?limit=100');
    $('audit').textContent = audit.length
      ? audit.map((a) => `${a.ts}  ${a.actor}  ${a.action}  ${a.target}${a.detail ? '  (' + a.detail + ')' : ''}`).join('\n')
      : '—';
  }

  async function loadConfig() {
    try {
      const c = await api('/config');
      $('mode-pill').textContent = `auth: ${c.authMode}`;
    } catch { /* handled by api */ }
  }

  async function refresh() {
    try { await Promise.all([loadUsers(), loadAudit()]); } catch { /* shown already */ }
  }

  async function act(email, action) {
    try {
      if (action === 'delete') {
        if (!confirm(`Delete ${email}? This removes the record entirely.`)) return;
        await api('/users/' + encodeURIComponent(email), { method: 'DELETE' });
      } else if (action === 'uninstall') {
        if (!confirm(`Remove the tool from ${email}'s computer?\n\nTheir app will uninstall itself on its next check-in (within ~2 min) and loses access immediately. Approving them again cancels it.`)) return;
        await api('/users/' + encodeURIComponent(email) + '/uninstall', { method: 'POST', body: '{}' });
      } else {
        await api('/users/' + encodeURIComponent(email) + '/' + action, { method: 'POST', body: '{}' });
      }
      notify(`${action} → ${email}`, true);
      await loadUsers();
      loadAudit();
    } catch (e) { notify(e.message, false); }
  }

  function startAuto() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { if ($('auto').checked && !$('app').classList.contains('hidden')) refresh(); }, 10000);
  }

  $('token-save').addEventListener('click', async () => {
    token = $('token-input').value.trim();
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    try { await loadConfig(); showApp(); refresh(); } catch { /* gate shown */ }
  });
  $('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('token-save').click(); });
  $('signout-btn').addEventListener('click', () => { localStorage.removeItem(TOKEN_KEY); token = ''; showGate(); });
  $('refresh-btn').addEventListener('click', refresh);
  $('add-btn').addEventListener('click', async () => {
    const email = $('add-email').value.trim().toLowerCase();
    const status = $('add-status').value;
    if (!email) return;
    try {
      await api('/users', { method: 'POST', body: JSON.stringify({ email, status }) });
      $('add-email').value = '';
      notify(`${status} → ${email}`, true);
      await loadUsers();
      loadAudit();
    } catch (e) { notify(e.message, false); }
  });
  $('users-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) act(btn.dataset.email, btn.dataset.act);
  });

  startAuto();
  if (token) {
    loadConfig().then(showApp).then(refresh).catch(() => showGate());
  } else {
    showGate();
  }
})();
