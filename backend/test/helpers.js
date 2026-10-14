'use strict';
const { buildConfig } = require('../src/config');
const { MemoryStore } = require('../src/store');
const { createServer } = require('../src/server');

// Starts the real Express app on an ephemeral port with an in-memory store and
// predictable stub config. Returns the base URL and a close().
async function startTestServer(overrides = {}, deps = {}) {
  const config = buildConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'stub',
    SESSION_SECRET: 'test-secret',
    ADMIN_TOKEN: 'test-admin',
    ADMIN_EMAILS: 'admin@corp.com',
    ...overrides,
  });
  config.quiet = true;
  const store = new MemoryStore();
  await store.init();
  const { app, codec } = createServer({ config, store, ...deps });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, config, store, codec, close: () => new Promise((resolve) => server.close(resolve)) };
}

// JSON fetch helper.
async function jreq(base, path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

module.exports = { startTestServer, jreq };
