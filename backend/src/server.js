'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createTokenCodec } = require('./tokens');
const { createIdentityResolver, isEmail, httpError } = require('./identity');
const { exchangeCodeForIdentity: defaultExchange } = require('./googleOauth');
const users = require('./users');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Wraps an async handler so thrown/rejected errors reach the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// Builds the Express app. Dependencies are injected so tests can pass a
// MemoryStore and custom config.
function createServer({ config, store, exchangeCodeForIdentity = defaultExchange }) {
  const codec = createTokenCodec(config.sessionSecret);
  const identity = createIdentityResolver(config);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  // --- root landing (friendly status page; this is an API otherwise) ---
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8" />
<title>Meeting Assistant · backend</title>
<body style="font-family:system-ui,Segoe UI,sans-serif;background:#0d0f12;color:#e3e6ea;margin:0;padding:48px;line-height:1.6">
  <h2 style="margin:0 0 6px">A2solveX Meeting Assistant — backend</h2>
  <p>Status: <b style="color:#50dea3">running</b> · auth mode: <b>${config.authMode}</b></p>
  <p style="margin-top:22px"><a href="/admin" style="color:#50dea3;font-weight:700">Open the admin page →</a></p>
  <p style="color:#8b929c">This is an API. Health: <a href="/healthz" style="color:#8b929c">/healthz</a>.
  Sign-in and user management happen under <code>/auth</code>, <code>/me</code>, and <code>/admin</code>.</p>
</body>`);
  });

  // --- health + public config ---
  app.get('/healthz', (_req, res) => res.json({ ok: true, authMode: config.authMode }));

  app.get('/auth/config', (_req, res) => {
    res.json({
      authMode: config.authMode,
      googleClientId: config.googleClientId, // public by design
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      offlineGraceMs: config.offlineGraceMs,
      sessionTtlMs: config.sessionTtlMs,
    });
  });

  // --- sign in ---
  async function issueSession(res, ident) {
    const user = await users.signIn(store, config, ident);
    const token = codec.sign({ email: user.email, sub: user.googleSub || ident.sub }, config.sessionTtlMs);
    res.json({
      token,
      user: users.summary(user),
      allowed: users.isAllowed(config, user),
      status: user.status,
      admin: users.isAdminEmail(config, user.email),
    });
  }

  // Accepts a client-obtained token: a real Google ID token (google mode) or a
  // "stub:<email>" token (stub mode, local/test only).
  app.post('/auth/google', wrap(async (req, res) => {
    if (config.authMode === 'stub' && config.devAuthSecret) {
      if (!safeEqual(req.get('x-dev-auth') || '', config.devAuthSecret)) {
        throw httpError('dev auth required', 401);
      }
    }
    const ident = await identity.resolve(req.body && req.body.idToken);
    await issueSession(res, ident);
  }));

  // Production desktop flow: the app sends the OAuth authorization code from its
  // loopback redirect; the server exchanges it (with the server-held client
  // secret) and verifies the identity.
  app.post('/auth/google/code', wrap(async (req, res) => {
    const ident = await exchangeCodeForIdentity(config, req.body || {});
    await issueSession(res, ident);
  }));

  // --- session middleware ---
  function requireSession(req, res, next) {
    const payload = codec.verify(bearer(req));
    if (!payload || !payload.email) return res.status(401).json({ error: 'invalid or expired session' });
    req.session = payload;
    next();
  }

  // --- heartbeat: live status (ban takes effect here) ---
  app.get('/me', requireSession, wrap(async (req, res) => {
    const current = await users.touch(store, req.session.email);
    if (!current) {
      // Account was deleted after the token was issued → treat as locked.
      return res.json({ user: { email: req.session.email, status: 'unknown' }, allowed: false, status: 'unknown' });
    }
    res.json({
      user: users.summary(current),
      allowed: users.isAllowed(config, current),
      status: current.status,
      admin: users.isAdminEmail(config, current.email),
      command: current.command || null,
    });
  }));

  // --- admin ---
  function requireAdmin(req, res, next) {
    const provided = req.get('x-admin-token') || bearer(req);
    if (!provided || !safeEqual(provided, config.adminToken)) {
      return res.status(401).json({ error: 'admin authorization required' });
    }
    next();
  }

  function targetEmail(req) {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw httpError('invalid target email', 400);
    return email;
  }

  const adminApi = express.Router();
  adminApi.use(requireAdmin);

  adminApi.get('/users', (_req, res) => res.json({ users: users.listUsers(store, config) }));
  adminApi.get('/audit', (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 1000);
    res.json({ audit: store.listAudit(limit) });
  });
  adminApi.get('/config', (_req, res) => res.json({ authMode: config.authMode, adminEmails: config.adminEmails }));

  adminApi.post('/users', wrap(async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!isEmail(email)) throw httpError('invalid email', 400);
    const status = (req.body && req.body.status) || 'approved';
    const user = await users.setStatus(store, config, adminActor(req), email, status, req.body && req.body.notes);
    res.json({ user: users.summary(user) });
  }));

  for (const [action, status] of [['approve', 'approved'], ['ban', 'banned'], ['unban', 'approved'], ['pending', 'pending']]) {
    adminApi.post(`/users/:email/${action}`, wrap(async (req, res) => {
      const user = await users.setStatus(store, config, adminActor(req), targetEmail(req), status, req.body && req.body.notes);
      res.json({ user: users.summary(user) });
    }));
  }

  // Flags the user's device to self-remove on its next heartbeat.
  adminApi.post('/users/:email/uninstall', wrap(async (req, res) => {
    const user = await users.uninstall(store, config, adminActor(req), targetEmail(req));
    res.json({ user: users.summary(user) });
  }));

  adminApi.delete('/users/:email', wrap(async (req, res) => {
    const existed = await users.remove(store, adminActor(req), targetEmail(req));
    res.json({ deleted: existed });
  }));

  app.use('/admin/api', adminApi);

  // Admin web page (static). Served after the API so /admin/api wins.
  app.use('/admin', express.static(path.join(__dirname, 'admin', 'public')));

  // --- 404 + error handler ---
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, _req, res, _next) => {
    const status = err.statusCode || err.status || 500;
    const message = status >= 500 ? 'internal error' : err.message || 'error';
    if (status >= 500 && !config.quiet) console.error('[server] error:', err);
    res.status(status).json({ error: message });
  });

  return { app, codec };
}

// Admins act via a shared token; label the audit actor by the admin email if the
// token carried one, else a generic label.
function adminActor(req) {
  return (req.get('x-admin-email') || 'admin').toString().trim().toLowerCase() || 'admin';
}

module.exports = { createServer };
