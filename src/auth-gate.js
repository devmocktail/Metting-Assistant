// Sign-in / access gate. Covers the whole window until the backend confirms the
// signed-in account is approved; re-appears immediately if a ban arrives via the
// heartbeat. Talks only to window.auth (preload bridge).
(() => {
  const $ = (id) => document.getElementById(id);
  const gate = $('auth-gate');
  if (!gate) return;
  let state = { phase: 'loading', allowed: false };

  const ICONS = {
    loading: 'ph-spinner-gap', signin: 'ph-sign-in', pending: 'ph-hourglass-medium',
    banned: 'ph-prohibit', offline: 'ph-wifi-slash', unknown: 'ph-question', error: 'ph-warning',
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(label, cls, handler) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await handler(); } finally { b.disabled = false; }
    });
    return b;
  }

  function render() {
    const { phase, allowed, status, authMode, email, name, message, online, signedIn } = state;
    if (allowed) {
      gate.hidden = true;
      document.body.classList.remove('locked');
      return;
    }
    gate.hidden = false;
    document.body.classList.add('locked');

    const actions = $('gate-actions');
    actions.replaceChildren();
    let title = 'Checking access…';
    let msg = message || '';
    let icon = ICONS.loading;

    if (phase === 'loading') {
      if (!msg) msg = 'Connecting to the access server…';
    } else if (phase === 'signin') {
      title = 'Sign in to continue';
      icon = ICONS.signin;
      if (!msg) msg = 'This tool is restricted to approved accounts.';
      if (authMode === 'google') {
        actions.append(button('Sign in with Google', 'primary-button gate-btn', () => window.auth.signInGoogle()));
      } else {
        const emailIn = el('input', 'gate-input');
        emailIn.type = 'email';
        emailIn.placeholder = 'you@company.com';
        emailIn.autocomplete = 'off';
        const nameIn = el('input', 'gate-input');
        nameIn.type = 'text';
        nameIn.placeholder = 'Your name (optional)';
        nameIn.autocomplete = 'off';
        const go = button('Dev sign in', 'primary-button gate-btn', async () => {
          const e = emailIn.value.trim();
          if (e) await window.auth.signInDev(e, nameIn.value.trim());
        });
        emailIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
        actions.append(emailIn, nameIn, go);
      }
    } else if (phase === 'locked') {
      if (status === 'banned') {
        title = 'Access revoked'; icon = ICONS.banned;
        if (!msg) msg = 'Your access has been disabled. Contact your administrator.';
      } else if (status === 'offline') {
        title = 'Server unreachable'; icon = ICONS.offline;
        if (!msg) msg = 'Cannot reach the access server, so the tool is locked until it is reachable again.';
        actions.append(button('Retry', 'primary-button gate-btn', () => window.auth.recheck()));
      } else if (status === 'unknown') {
        title = 'Account not found'; icon = ICONS.unknown;
        if (!msg) msg = 'This account is no longer registered. Sign in again.';
      } else {
        title = 'Waiting for approval'; icon = ICONS.pending;
        if (!msg) msg = 'Your request is pending an administrator’s approval. You will get in as soon as you are approved.';
        actions.append(button('Check again', 'primary-button gate-btn', () => window.auth.recheck()));
      }
    }

    $('gate-title').textContent = title;
    $('gate-message').textContent = msg;
    $('gate-icon').innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i>`;

    if (signedIn && phase !== 'signin') {
      actions.append(button('Sign out', 'secondary-button gate-btn', () => window.auth.signOut()));
    }
    $('gate-foot').textContent = email
      ? `Signed in as ${email}${name ? ` (${name})` : ''}${online === false ? ' · offline' : ''}`
      : '';
  }

  $('gate-close').addEventListener('click', () => window.privacy.controlWindow('close'));
  $('gate-compact').addEventListener('click', () => window.privacy.toggleCompact());

  window.auth.onAuthState((s) => { state = s; render(); });
  window.auth.getState().then((s) => { if (s) state = s; render(); }).catch(render);
  render();
})();
