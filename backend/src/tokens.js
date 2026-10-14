'use strict';
// Compact signed session tokens (HMAC-SHA256), no external dependency.
// Format: base64url(JSON payload) + "." + base64url(HMAC). The payload carries
// identity + exp; the user's live status is always re-read from the store, never
// trusted from the token, so a ban takes effect immediately.
const crypto = require('node:crypto');

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeToString(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function createTokenCodec(secret) {
  if (!secret || typeof secret !== 'string') throw new Error('token secret required');

  function sign(payload, ttlMs) {
    const now = Date.now();
    const body = { ...payload, iat: now, exp: now + (Number.isFinite(ttlMs) ? ttlMs : 0) };
    const encoded = b64urlEncode(JSON.stringify(body));
    const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(encoded).digest());
    return `${encoded}.${sig}`;
  }

  function verify(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const encoded = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64urlEncode(crypto.createHmac('sha256', secret).update(encoded).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try {
      payload = JSON.parse(b64urlDecodeToString(encoded));
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp === 'number' && payload.exp > 0 && Date.now() > payload.exp) return null;
    return payload;
  }

  return { sign, verify };
}

module.exports = { createTokenCodec };
