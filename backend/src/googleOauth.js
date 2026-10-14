'use strict';
const { OAuth2Client } = require('google-auth-library');
const { httpError } = require('./identity');

// Exchanges an OAuth 2.0 authorization code (from the desktop app's loopback
// flow) for a verified Google identity. The client secret stays on the server,
// so it is never shipped inside the desktop app.
async function exchangeCodeForIdentity(config, params = {}) {
  const { code, codeVerifier, redirectUri } = params;
  if (config.authMode !== 'google') throw httpError('code exchange requires google auth mode', 400);
  if (!config.googleClientId || !config.googleClientSecret) throw httpError('server missing Google client credentials', 500);
  if (!code || !codeVerifier || !redirectUri) throw httpError('code, codeVerifier, redirectUri required', 400);

  const body = new URLSearchParams({
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw httpError(`Google token exchange failed: ${res.status} ${t.slice(0, 120)}`, 401);
  }
  const data = await res.json();
  if (!data.id_token) throw httpError('Google token response missing id_token', 401);

  const client = new OAuth2Client(config.googleClientId);
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: data.id_token, audience: config.googleClientId });
    payload = ticket.getPayload();
  } catch {
    throw httpError('Google id_token verification failed', 401);
  }
  if (!payload || !payload.email) throw httpError('Google id_token missing email', 401);
  if (payload.email_verified === false) throw httpError('Google email not verified', 403);
  return { sub: payload.sub, email: String(payload.email).toLowerCase(), emailVerified: true, name: payload.name || '' };
}

module.exports = { exchangeCodeForIdentity };
