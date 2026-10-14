'use strict';
// Electron-agnostic auth client (runs in the main process, but depends only on
// injected primitives so it is unit-testable). Owns the session token, talks to
// the backend, and tracks whether the tool is currently allowed. The backend's
// live status is the source of truth, so a ban locks the tool on the next
// heartbeat even mid-session.

function createAuthClient(opts) {
  const {
    backendUrl,
    storage, // { load(): {token}|null, save({token,email}), clear() }
    fetchImpl = (...a) => fetch(...a),
    now = () => Date.now(),
    heartbeatMs = 120000,
    offlineGraceMs = 600000,
    onState = () => {},
    runGoogleAuth = null, // async ({clientId}) => { code, codeVerifier, redirectUri }
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = opts;

  const base = String(backendUrl || '').replace(/\/+$/, '');
  let token = null;
  let timer = null;
  let state = {
    phase: 'loading', // loading | signin | locked | allowed
    authMode: null,
    googleClientId: '',
    signedIn: false,
    email: null,
    name: null,
    status: null, // pending | approved | banned | unknown | offline | signedout
    allowed: false,
    admin: false,
    online: true,
    message: '',
    lastOkAt: 0,
    backendUrl: base,
  };

  const getState = () => ({ ...state });
  function setState(patch) {
    state = { ...state, ...patch };
    try { onState(getState()); } catch { /* listener errors are not fatal */ }
  }

  async function api(path, { method = 'GET', body, authToken } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetchImpl(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore non-JSON */ }
    return { status: res.status, ok: res.ok, data };
  }

  async function loadConfig() {
    try {
      const r = await api('/auth/config');
      if (r.ok && r.data) {
        setState({ authMode: r.data.authMode, googleClientId: r.data.googleClientId || '' });
        return r.data;
      }
    } catch { /* offline — handled by callers */ }
    return null;
  }

  function persist(email) {
    try { storage.save({ token, email: email || state.email || null }); } catch { /* best effort */ }
  }
  function clearToken() {
    token = null;
    try { storage.clear(); } catch { /* best effort */ }
  }

  function applyAuthData(data) {
    setState({
      phase: data.allowed ? 'allowed' : 'locked',
      signedIn: true,
      email: data.user.email,
      name: data.user.name || '',
      status: data.status,
      allowed: !!data.allowed,
      admin: !!data.admin,
      online: true,
      message: '',
      lastOkAt: now(),
    });
  }

  function handleOffline(message) {
    const graceLeft = offlineGraceMs - (now() - state.lastOkAt);
    const keep = state.signedIn && state.allowed && graceLeft > 0;
    if (keep) {
      setState({ online: false, message: `Offline — tool stays unlocked for ~${Math.max(1, Math.round(graceLeft / 60000))} min.` });
    } else {
      setState({
        phase: state.signedIn ? 'locked' : 'signin',
        allowed: false,
        online: false,
        status: state.signedIn ? 'offline' : state.status,
        message: message || 'Cannot reach the server.',
      });
    }
  }

  // Heartbeat / status check. Ban or approval changes are picked up here.
  async function recheck() {
    if (!token) {
      setState({ phase: 'signin', signedIn: false, allowed: false, status: state.status || 'signedout' });
      return getState();
    }
    try {
      const r = await api('/me', { authToken: token });
      if (r.ok && r.data) {
        applyAuthData(r.data);
      } else if (r.status === 401) {
        clearToken();
        setState({ phase: 'signin', signedIn: false, email: null, status: 'signedout', allowed: false, online: true, message: 'Your session expired. Please sign in again.' });
      } else {
        handleOffline('Server error — tool locked.');
      }
    } catch {
      handleOffline('Cannot reach the server.');
    }
    return getState();
  }

  function consumeAuthResponse(r) {
    if (r.ok && r.data && r.data.token) {
      token = r.data.token;
      persist(r.data.user && r.data.user.email);
      applyAuthData(r.data);
    } else {
      setState({ message: (r.data && r.data.error) || 'Sign-in failed.' });
    }
    return getState();
  }

  // Local/test sign-in (backend must be in stub mode).
  async function signInStub(email, name) {
    const idToken = `stub:${email}${name ? ':' + name : ''}`;
    try {
      const r = await api('/auth/google', { method: 'POST', body: { idToken } });
      return consumeAuthResponse(r);
    } catch {
      setState({ message: 'Cannot reach the server.' });
      return getState();
    }
  }

  // Production Google sign-in via the loopback flow (runGoogleAuth injected).
  async function signInGoogle() {
    if (!runGoogleAuth) { setState({ message: 'Google sign-in is unavailable.' }); return getState(); }
    try {
      const conf = (await loadConfig()) || { googleClientId: state.googleClientId };
      if (!conf.googleClientId) throw new Error('backend has no Google client id configured');
      const { code, codeVerifier, redirectUri } = await runGoogleAuth({ clientId: conf.googleClientId });
      const r = await api('/auth/google/code', { method: 'POST', body: { code, codeVerifier, redirectUri } });
      return consumeAuthResponse(r);
    } catch (e) {
      setState({ phase: token ? 'locked' : 'signin', message: `Google sign-in failed: ${(e && e.message) || 'error'}` });
      return getState();
    }
  }

  function signOut() {
    clearToken();
    setState({ phase: 'signin', signedIn: false, email: null, name: null, status: 'signedout', allowed: false, online: true, message: '' });
    return getState();
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (!(heartbeatMs > 0)) return;
    const tick = async () => {
      await recheck();
      timer = setTimeoutImpl(tick, heartbeatMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    timer = setTimeoutImpl(tick, heartbeatMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function stopHeartbeat() {
    if (timer) { clearTimeoutImpl(timer); timer = null; }
  }

  async function init() {
    const saved = (() => { try { return storage.load(); } catch { return null; } })();
    token = (saved && saved.token) || null;
    if (saved && saved.email) state.email = saved.email;
    await loadConfig();
    if (!token) setState({ phase: 'signin', signedIn: false, allowed: false, status: 'signedout' });
    else await recheck();
    startHeartbeat();
    return getState();
  }

  return {
    init, recheck, signInStub, signInGoogle, signOut,
    startHeartbeat, stopHeartbeat, getState,
    _setTokenForTest: (t) => { token = t; },
  };
}

module.exports = { createAuthClient };
