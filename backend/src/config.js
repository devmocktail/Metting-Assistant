'use strict';
const crypto = require('node:crypto');

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseEmails(value) {
  return String(value || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Builds the immutable config object from process.env (with optional overrides for
// tests). Fails fast in production when required secrets are missing; in dev it
// fills predictable placeholders so the local admin page and tests just work.
function buildConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const isProd = env.NODE_ENV === 'production';
  const authMode = (env.AUTH_MODE || 'stub').toLowerCase();

  const missing = [];
  if (isProd) {
    if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
    if (!env.ADMIN_TOKEN) missing.push('ADMIN_TOKEN');
    if (authMode === 'google' && !env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
    if ((env.STORE || 'json').toLowerCase() === 'upstash') {
      if (!env.UPSTASH_REDIS_REST_URL) missing.push('UPSTASH_REDIS_REST_URL');
      if (!env.UPSTASH_REDIS_REST_TOKEN) missing.push('UPSTASH_REDIS_REST_TOKEN');
    }
    if ((env.STORE || 'json').toLowerCase() === 'mysql') {
      for (const k of ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']) {
        if (!env[k]) missing.push(k);
      }
    }
    if (missing.length) {
      throw new Error(`Missing required production env vars: ${missing.join(', ')}`);
    }
  }

  const warnings = [];
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    sessionSecret = 'dev-session-secret-change-me';
    warnings.push('SESSION_SECRET not set — using an insecure dev default.');
  }
  let adminToken = env.ADMIN_TOKEN;
  if (!adminToken) {
    adminToken = 'dev-admin-token';
    warnings.push('ADMIN_TOKEN not set — using insecure dev default "dev-admin-token".');
  }

  return {
    isProd,
    port: toInt(env.PORT, 8787),
    authMode: authMode === 'google' ? 'google' : 'stub',
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    sessionSecret,
    adminToken,
    adminEmails: parseEmails(env.ADMIN_EMAILS),
    sessionTtlMs: toInt(env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),
    heartbeatIntervalMs: toInt(env.HEARTBEAT_INTERVAL_MS, 2 * 60 * 1000),
    offlineGraceMs: toInt(env.OFFLINE_GRACE_MS, 10 * 60 * 1000),
    store: (env.STORE || 'json').toLowerCase(),
    dataDir: env.DATA_DIR || './data',
    upstashUrl: env.UPSTASH_REDIS_REST_URL || '',
    upstashToken: env.UPSTASH_REDIS_REST_TOKEN || '',
    mysqlHost: env.MYSQL_HOST || '',
    mysqlPort: toInt(env.MYSQL_PORT, 3306),
    mysqlUser: env.MYSQL_USER || '',
    mysqlPassword: env.MYSQL_PASSWORD || '',
    mysqlDatabase: env.MYSQL_DATABASE || '',
    devAuthSecret: env.DEV_AUTH_SECRET || '',
    warnings,
  };
}

function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { buildConfig, parseEmails, randomSecret };
