'use strict';
const { OAuth2Client } = require('google-auth-library');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isEmail(value) {
  return typeof value === 'string' && value.length <= 320 && EMAIL_RE.test(value);
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Resolves a client-supplied token into a verified identity {sub,email,name}.
// - google mode: verifies a real Google ID token (signature, audience, expiry).
// - stub mode:   accepts "stub:<email>[:<name>]" so gating logic is testable
//                without real Google. Never enabled in google mode.
function createIdentityResolver(config) {
  const client = config.authMode === 'google' ? new OAuth2Client(config.googleClientId) : null;

  async function resolve(idToken) {
    if (typeof idToken !== 'string' || !idToken) throw httpError('idToken required', 400);

    if (config.authMode === 'stub') {
      if (!idToken.startsWith('stub:')) throw httpError('stub auth expects a "stub:" token', 400);
      const rest = idToken.slice(5);
      const sep = rest.indexOf(':');
      const email = (sep === -1 ? rest : rest.slice(0, sep)).trim().toLowerCase();
      const name = sep === -1 ? '' : rest.slice(sep + 1).trim();
      if (!isEmail(email)) throw httpError('invalid stub email', 400);
      return { sub: `stub:${email}`, email, emailVerified: true, name: name || email };
    }

    // google mode
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: config.googleClientId });
      payload = ticket.getPayload();
    } catch {
      throw httpError('Google token verification failed', 401);
    }
    if (!payload || !payload.email) throw httpError('Google token missing email', 401);
    if (payload.email_verified === false) throw httpError('Google email not verified', 403);
    return {
      sub: payload.sub,
      email: String(payload.email).toLowerCase(),
      emailVerified: payload.email_verified !== false,
      name: payload.name || '',
    };
  }

  return { resolve };
}

module.exports = { createIdentityResolver, isEmail, httpError };
