'use strict';
// Desktop "installed app" OAuth 2.0 loopback flow with PKCE. Opens the system
// browser to Google, captures the authorization code on a localhost redirect,
// and returns the code (+ PKCE verifier + redirect URI) for the backend to
// exchange. The client secret never touches this process.
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const DONE_HTML =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font-family:system-ui,sans-serif;background:#0d0f12;color:#e3e6ea;text-align:center;padding-top:90px">' +
  '<h2>Sign-in complete</h2><p>You can close this tab and return to the app.</p></body>';

function runLoopbackAuth({ clientId, openBrowser, scope = 'openid email profile', timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    if (!clientId) { reject(new Error('missing Google client id')); return; }
    if (typeof openBrowser !== 'function') { reject(new Error('openBrowser required')); return; }

    const codeVerifier = b64url(crypto.randomBytes(32));
    const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
    const stateParam = b64url(crypto.randomBytes(16));
    let redirectUri = '';
    let settled = false;
    let timer = null;

    const server = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end('bad request'); return; }
      if (u.pathname !== '/callback') { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DONE_HTML);
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const st = u.searchParams.get('state');
      finish(() => {
        if (err) throw new Error(`Google returned: ${err}`);
        if (!code) throw new Error('no authorization code returned');
        if (st !== stateParam) throw new Error('state mismatch (possible CSRF)');
        return { code, codeVerifier, redirectUri };
      });
    });

    function cleanup() { if (timer) clearTimeout(timer); try { server.close(); } catch { /* ignore */ } }
    function finish(produce) {
      if (settled) return;
      settled = true;
      cleanup();
      try { resolve(produce()); } catch (e) { reject(e); }
    }
    function fail(e) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    }

    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', stateParam);
      authUrl.searchParams.set('prompt', 'select_account');
      timer = setTimeout(() => fail(new Error('sign-in timed out')), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      Promise.resolve()
        .then(() => openBrowser(authUrl.toString()))
        .catch((e) => fail(e instanceof Error ? e : new Error('could not open browser')));
    });
  });
}

module.exports = { runLoopbackAuth };
