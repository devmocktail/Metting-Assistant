'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startTestServer, jreq } = require('./helpers');

const ADMIN = { 'X-Admin-Token': 'test-admin' };
const enc = encodeURIComponent;

test('healthz + public auth config', async () => {
  const s = await startTestServer();
  try {
    let r = await jreq(s.base, '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    r = await jreq(s.base, '/auth/config');
    assert.equal(r.status, 200);
    assert.equal(r.body.authMode, 'stub');
    assert.ok(typeof r.body.heartbeatIntervalMs === 'number');
  } finally { await s.close(); }
});

test('full lifecycle: pending → approve → ban (immediate via /me)', async () => {
  const s = await startTestServer();
  try {
    let r = await jreq(s.base, '/auth/google', { method: 'POST', body: JSON.stringify({ idToken: 'stub:sales@corp.com:Sales Rep' }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'pending');
    assert.equal(r.body.allowed, false);
    const auth = { Authorization: 'Bearer ' + r.body.token };
    assert.ok(r.body.token);

    r = await jreq(s.base, '/me', { headers: auth });
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.status, 'pending');

    // admin requires token
    r = await jreq(s.base, '/admin/api/users');
    assert.equal(r.status, 401);

    r = await jreq(s.base, '/admin/api/users', { headers: ADMIN });
    assert.equal(r.status, 200);
    assert.equal(r.body.users.length, 1);

    // approve → allowed with the SAME session token
    r = await jreq(s.base, `/admin/api/users/${enc('sales@corp.com')}/approve`, { method: 'POST', headers: ADMIN, body: '{}' });
    assert.equal(r.body.user.status, 'approved');
    r = await jreq(s.base, '/me', { headers: auth });
    assert.equal(r.body.allowed, true);

    // ban → locks immediately, same token
    r = await jreq(s.base, `/admin/api/users/${enc('sales@corp.com')}/ban`, { method: 'POST', headers: ADMIN, body: '{}' });
    assert.equal(r.body.user.status, 'banned');
    r = await jreq(s.base, '/me', { headers: auth });
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.status, 'banned');

    // unban → allowed again
    r = await jreq(s.base, `/admin/api/users/${enc('sales@corp.com')}/unban`, { method: 'POST', headers: ADMIN, body: '{}' });
    r = await jreq(s.base, '/me', { headers: auth });
    assert.equal(r.body.allowed, true);
  } finally { await s.close(); }
});

test('admin email auto-approved on sign-in', async () => {
  const s = await startTestServer();
  try {
    const r = await jreq(s.base, '/auth/google', { method: 'POST', body: JSON.stringify({ idToken: 'stub:admin@corp.com:Boss' }) });
    assert.equal(r.body.status, 'approved');
    assert.equal(r.body.allowed, true);
    assert.equal(r.body.admin, true);
  } finally { await s.close(); }
});

test('pre-approve an email, then first sign-in is allowed', async () => {
  const s = await startTestServer();
  try {
    let r = await jreq(s.base, '/admin/api/users', { method: 'POST', headers: ADMIN, body: JSON.stringify({ email: 'vip@corp.com', status: 'approved' }) });
    assert.equal(r.status, 200);
    r = await jreq(s.base, '/auth/google', { method: 'POST', body: JSON.stringify({ idToken: 'stub:vip@corp.com' }) });
    assert.equal(r.body.allowed, true);
  } finally { await s.close(); }
});

test('deleted account locks /me (status unknown)', async () => {
  const s = await startTestServer();
  try {
    let r = await jreq(s.base, '/auth/google', { method: 'POST', body: JSON.stringify({ idToken: 'stub:temp@corp.com' }) });
    const auth = { Authorization: 'Bearer ' + r.body.token };
    r = await jreq(s.base, `/admin/api/users/${enc('temp@corp.com')}`, { method: 'DELETE', headers: ADMIN });
    assert.equal(r.body.deleted, true);
    r = await jreq(s.base, '/me', { headers: auth });
    assert.equal(r.body.status, 'unknown');
    assert.equal(r.body.allowed, false);
  } finally { await s.close(); }
});

test('bad inputs: invalid session, bad token, 404', async () => {
  const s = await startTestServer();
  try {
    let r = await jreq(s.base, '/me', { headers: { Authorization: 'Bearer nope' } });
    assert.equal(r.status, 401);
    r = await jreq(s.base, '/auth/google', { method: 'POST', body: JSON.stringify({ idToken: 'garbage' }) });
    assert.equal(r.status, 400);
    r = await jreq(s.base, '/me'); // no auth header
    assert.equal(r.status, 401);
    r = await jreq(s.base, '/does-not-exist');
    assert.equal(r.status, 404);
  } finally { await s.close(); }
});

test('audit records signup and admin actions', async () => {
  const s = await startTestServer();
  try {
    await jreq(s.base, '/auth/google', { method: 'POST', body: JSON.stringify({ idToken: 'stub:a@corp.com' }) });
    await jreq(s.base, `/admin/api/users/${enc('a@corp.com')}/approve`, { method: 'POST', headers: ADMIN, body: '{}' });
    const r = await jreq(s.base, '/admin/api/audit', { headers: ADMIN });
    assert.equal(r.status, 200);
    const actions = r.body.audit.map((a) => a.action);
    assert.ok(actions.includes('signup'));
    assert.ok(actions.includes('set:approved'));
  } finally { await s.close(); }
});

test('DEV_AUTH_SECRET gates stub sign-in', async () => {
  const s = await startTestServer({ DEV_AUTH_SECRET: 'devsecret' });
  try {
    let r = await jreq(s.base, '/auth/google', { method: 'POST', body: JSON.stringify({ idToken: 'stub:x@corp.com' }) });
    assert.equal(r.status, 401);
    r = await jreq(s.base, '/auth/google', { method: 'POST', headers: { 'X-Dev-Auth': 'devsecret' }, body: JSON.stringify({ idToken: 'stub:x@corp.com' }) });
    assert.equal(r.status, 200);
  } finally { await s.close(); }
});

test('admin uninstall sets command + bans; a status change clears it', async () => {
  const s = await startTestServer();
  try {
    let r = await jreq(s.base, '/auth/google', { method: 'POST', body: JSON.stringify({ idToken: 'stub:gone@corp.com' }) });
    const auth = { Authorization: 'Bearer ' + r.body.token };

    r = await jreq(s.base, `/admin/api/users/${enc('gone@corp.com')}/uninstall`, { method: 'POST', headers: ADMIN, body: '{}' });
    assert.equal(r.body.user.status, 'banned');
    assert.equal(r.body.user.command, 'uninstall');

    r = await jreq(s.base, '/me', { headers: auth });
    assert.equal(r.body.command, 'uninstall');
    assert.equal(r.body.allowed, false);

    // Re-approving cancels the pending uninstall.
    r = await jreq(s.base, `/admin/api/users/${enc('gone@corp.com')}/approve`, { method: 'POST', headers: ADMIN, body: '{}' });
    assert.equal(r.body.user.command, null);
    r = await jreq(s.base, '/me', { headers: auth });
    assert.equal(r.body.command, null);
    assert.equal(r.body.allowed, true);
  } finally { await s.close(); }
});

test('google code-exchange path issues a session (injected exchanger)', async () => {
  const fakeExchange = async (_cfg, body) => {
    assert.equal(body.code, 'abc');
    assert.equal(body.codeVerifier, 'verifier');
    return { sub: 'g1', email: 'g@corp.com', name: 'G User' };
  };
  const s = await startTestServer(
    { AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' },
    { exchangeCodeForIdentity: fakeExchange },
  );
  try {
    const r = await jreq(s.base, '/auth/google/code', {
      method: 'POST',
      body: JSON.stringify({ code: 'abc', codeVerifier: 'verifier', redirectUri: 'http://127.0.0.1:1/cb' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.email, 'g@corp.com');
    assert.equal(r.body.status, 'pending');
    assert.ok(r.body.token);
  } finally { await s.close(); }
});

test('serves the admin page and its script', async () => {
  const s = await startTestServer();
  try {
    const page = await fetch(s.base + '/admin/');
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(html.includes('A2solveX'));
    const js = await fetch(s.base + '/admin/admin.js');
    assert.equal(js.status, 200);
  } finally { await s.close(); }
});
