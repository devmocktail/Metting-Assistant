'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildConfig } = require('../backend/src/config');
const { MemoryStore } = require('../backend/src/store');
const { createServer } = require('../backend/src/server');
const { createAuthClient } = require('../src/auth/authClient');

function memStorage(initial = null) {
  let v = initial;
  return { load: () => v, save: (o) => { v = o; }, clear: () => { v = null; } };
}

async function startBackend() {
  const config = buildConfig({ NODE_ENV: 'test', AUTH_MODE: 'stub', SESSION_SECRET: 's', ADMIN_TOKEN: 'adm', ADMIN_EMAILS: 'admin@corp.com' });
  config.quiet = true;
  const store = new MemoryStore();
  await store.init();
  const { app } = createServer({ config, store });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function adminPost(base, path) {
  const r = await fetch(base + '/admin/api' + path, {
    method: 'POST', headers: { 'X-Admin-Token': 'adm', 'Content-Type': 'application/json' }, body: '{}',
  });
  return r.json();
}

test('authClient stub lifecycle: signin → pending → approve → ban → signout', async () => {
  const be = await startBackend();
  try {
    const c = createAuthClient({ backendUrl: be.base, storage: memStorage(), heartbeatMs: 0 });
    let s = await c.init();
    assert.equal(s.phase, 'signin');
    assert.equal(s.authMode, 'stub');

    s = await c.signInStub('sales@corp.com', 'Sales Rep');
    assert.equal(s.allowed, false);
    assert.equal(s.status, 'pending');
    assert.equal(s.phase, 'locked');
    assert.equal(s.email, 'sales@corp.com');

    await adminPost(be.base, '/users/' + encodeURIComponent('sales@corp.com') + '/approve');
    s = await c.recheck();
    assert.equal(s.allowed, true);
    assert.equal(s.phase, 'allowed');

    await adminPost(be.base, '/users/' + encodeURIComponent('sales@corp.com') + '/ban');
    s = await c.recheck();
    assert.equal(s.allowed, false);
    assert.equal(s.status, 'banned');
    assert.equal(s.phase, 'locked');

    s = c.signOut();
    assert.equal(s.signedIn, false);
    assert.equal(s.phase, 'signin');
  } finally { await be.close(); }
});

test('authClient persists token across restarts', async () => {
  const be = await startBackend();
  try {
    const storage = memStorage();
    const c1 = createAuthClient({ backendUrl: be.base, storage, heartbeatMs: 0 });
    await c1.init();
    await c1.signInStub('admin@corp.com', 'Boss'); // admin → approved
    assert.ok(storage.load() && storage.load().token, 'token saved');

    // New client instance reuses the saved token (no re-sign-in).
    const c2 = createAuthClient({ backendUrl: be.base, storage, heartbeatMs: 0 });
    const s = await c2.init();
    assert.equal(s.signedIn, true);
    assert.equal(s.allowed, true);
    assert.equal(s.email, 'admin@corp.com');
  } finally { await be.close(); }
});

test('offline grace keeps the tool unlocked, then locks after grace', async () => {
  let t = 1_000_000;
  const now = () => t;
  let online = true;
  const jsonRes = (obj, status = 200, ok = true) => ({ status, ok, json: async () => obj });
  const fetchImpl = async (url) => {
    if (!online) throw new Error('network down');
    if (url.endsWith('/auth/config')) return jsonRes({ authMode: 'google', googleClientId: 'cid', heartbeatIntervalMs: 1, offlineGraceMs: 1 });
    if (url.endsWith('/me')) return jsonRes({ user: { email: 'u@corp.com', name: 'U' }, allowed: true, status: 'approved', admin: false });
    return jsonRes({}, 404, false);
  };
  const c = createAuthClient({ backendUrl: 'http://x', storage: memStorage({ token: 'tok' }), heartbeatMs: 0, now, offlineGraceMs: 600000, fetchImpl });

  let s = await c.init();
  assert.equal(s.allowed, true);

  online = false;
  t += 60_000; // within grace
  s = await c.recheck();
  assert.equal(s.allowed, true);
  assert.equal(s.online, false);

  t += 600_000; // beyond grace
  s = await c.recheck();
  assert.equal(s.allowed, false);
  assert.equal(s.status, 'offline');
});

test('expired/invalid session (401) forces re-sign-in', async () => {
  const jsonRes = (obj, status = 200, ok = true) => ({ status, ok, json: async () => obj });
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/config')) return jsonRes({ authMode: 'stub', googleClientId: '' });
    if (url.endsWith('/me')) return jsonRes({ error: 'invalid or expired session' }, 401, false);
    return jsonRes({}, 404, false);
  };
  const storage = memStorage({ token: 'stale' });
  const c = createAuthClient({ backendUrl: 'http://x', storage, heartbeatMs: 0, fetchImpl });
  const s = await c.init();
  assert.equal(s.phase, 'signin');
  assert.equal(s.signedIn, false);
  assert.equal(storage.load(), null, 'stale token cleared');
});
