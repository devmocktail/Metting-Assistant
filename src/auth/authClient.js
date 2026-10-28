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
    device = { id: '', name: '' }, // { id, name } — binds the account to this machine
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
    command: null,
    backendUrl: base,
    // Plans / billing.
    selectedPlan: null,        // 'trial' | 'pro' — what the user picked on the pricing screen
    plan: null,                // the account's current plan from the backend
    reason: null,              // why locked: trial_expired | payment_required | pending | banned | ...
    trialDaysLeft: null,
    trialEndsAt: null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    planAmountInr: 999,
    boundDeviceName: null,     // when locked for device_mismatch: the machine that holds the seat
  };

  const getState = () => ({ ...state });
  function setState(patch) {
    state = { ...state, ...patch };
    try { onState(getState()); } catch { /* listener errors are not fatal */ }
  }

  const deviceId = (device && device.id) || '';
  const deviceName = (device && device.name) || '';

  async function api(path, { method = 'GET', body, authToken } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    // Device binding: the machine id travels on every request (sign-in and the
    // heartbeat /me) so the backend can enforce one-account-one-machine.
    if (deviceId) { headers['X-Device-Id'] = deviceId; headers['X-Device-Name'] = deviceName; }
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
      command: data.command || null,
      plan: data.plan ?? null,
      reason: data.reason ?? null,
      trialDaysLeft: data.trialDaysLeft ?? null,
      trialEndsAt: data.trialEndsAt ?? null,
      subscriptionStatus: data.subscriptionStatus ?? null,
      currentPeriodEnd: data.currentPeriodEnd ?? null,
      planAmountInr: data.planAmountInr ?? state.planAmountInr ?? 999,
      boundDeviceName: data.boundDeviceName ?? null,
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
  async function signInStub(email, name, plan) {
    if (plan) setState({ selectedPlan: plan });
    const idToken = `stub:${email}${name ? ':' + name : ''}`;
    try {
      const r = await api('/auth/google', { method: 'POST', body: { idToken, device: { id: deviceId, name: deviceName } } });
      return consumeAuthResponse(r);
    } catch {
      setState({ message: 'Cannot reach the server.' });
      return getState();
    }
  }

  // Production Google sign-in via the loopback flow (runGoogleAuth injected).
  // `plan` is the pricing-screen choice; it only decides whether the app offers
  // the Pro checkout after sign-in (the backend always starts everyone on a trial).
  async function signInGoogle(plan) {
    if (plan) setState({ selectedPlan: plan });
    if (!runGoogleAuth) { setState({ message: 'Google sign-in is unavailable.' }); return getState(); }
    try {
      const conf = (await loadConfig()) || { googleClientId: state.googleClientId };
      if (!conf.googleClientId) throw new Error('backend has no Google client id configured');
      const { code, codeVerifier, redirectUri } = await runGoogleAuth({ clientId: conf.googleClientId });
      const r = await api('/auth/google/code', { method: 'POST', body: { code, codeVerifier, redirectUri, device: { id: deviceId, name: deviceName } } });
      return consumeAuthResponse(r);
    } catch (e) {
      setState({ phase: token ? 'locked' : 'signin', message: `Google sign-in failed: ${(e && e.message) || 'error'}` });
      return getState();
    }
  }

  // Ask the backend to create a Razorpay subscription for the signed-in user.
  // Returns { ok, subscriptionId, keyId, planAmountInr, payUrl } or { ok:false, error }.
  async function subscribe() {
    if (!token) return { ok: false, error: 'Sign in first.' };
    try {
      const r = await api('/billing/subscribe', { method: 'POST', authToken: token, body: {} });
      if (r.ok && r.data && r.data.subscriptionId) return { ok: true, ...r.data };
      return { ok: false, error: (r.data && r.data.error) || 'Could not start the subscription.' };
    } catch {
      return { ok: false, error: 'Cannot reach the server.' };
    }
  }

  // Self-service "use on this device instead": move the account's single seat to
  // this machine. Subject to the backend's move cooldown.
  async function claimDevice() {
    if (!token) return getState();
    try {
      const r = await api('/device/claim', { method: 'POST', authToken: token, body: { device: { id: deviceId, name: deviceName } } });
      if (r.ok && r.data) {
        applyAuthData(r.data);
      } else {
        setState({ message: (r.data && r.data.error) || 'Could not move the device.' });
      }
    } catch {
      setState({ message: 'Cannot reach the server.' });
    }
    return getState();
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
    init, recheck, signInStub, signInGoogle, signOut, subscribe, claimDevice,
    startHeartbeat, stopHeartbeat, getState,
    _setTokenForTest: (t) => { token = t; },
  };
}

module.exports = { createAuthClient };
