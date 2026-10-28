// Sign-in / access gate. Covers the whole window until the backend confirms the
// signed-in account is approved; re-appears immediately if a ban arrives via the
// heartbeat. Talks only to window.auth (preload bridge).
(() => {
  const $ = (id) => document.getElementById(id);
  const gate = $('auth-gate');
  if (!gate) return;
  let state = { phase: 'loading', allowed: false };
  let chosenPlan = null;   // pricing-screen selection, before sign-in
  let prevSignedIn = false; // so a sign-out returns the user to the pricing screen

  const ICONS = {
    loading: 'ph-spinner-gap', signin: 'ph-sign-in', pending: 'ph-hourglass-medium',
    banned: 'ph-prohibit', offline: 'ph-wifi-slash', unknown: 'ph-question', error: 'ph-warning',
    upgrade: 'ph-crown', device: 'ph-desktop',
  };

  // Official multi-colour Google "G" mark for the Continue-with-Google button.
  const GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true">'
    + '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
    + '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
    + '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
    + '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

  // Status/reason → accent class for the icon tile.
  const ICON_CLASS = {
    banned: 'danger', removed: 'danger', pending: 'warn', offline: 'neutral', unknown: 'neutral',
    trial_expired: 'warn', payment_required: 'warn', device_mismatch: 'warn',
  };

  const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

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
  // Cream "Continue with Google" pill with the official G mark (trusted static SVG).
  function googleButton(plan) {
    const b = el('button', 'google-btn gate-btn');
    b.type = 'button';
    b.innerHTML = `${GOOGLE_G}<span>Continue with Google</span>`;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await window.auth.signInGoogle(plan); } finally { b.disabled = false; }
    });
    return b;
  }

  // A selectable pricing card. Static text only — safe to use innerHTML.
  function planCard({ id, name, price, per, features, cta, featured }) {
    const card = el('button', 'plan-card' + (featured ? ' featured' : ''));
    card.type = 'button';
    const feats = features.map((f) => `<li><i class="ph ph-check-circle" aria-hidden="true"></i><span>${f}</span></li>`).join('');
    card.innerHTML = `
      <div class="plan-head"><span class="plan-name">${name}</span>${featured ? '<span class="plan-flag">Popular</span>' : ''}</div>
      <div class="plan-price">${price}<span class="plan-per">${per || ''}</span></div>
      <ul class="plan-feat">${feats}</ul>
      <span class="plan-cta">${cta}</span>`;
    card.addEventListener('click', () => { chosenPlan = id; render(); });
    return card;
  }

  // Prominent green "Upgrade to Pro" button → opens Razorpay checkout.
  function upgradeButton(amount) {
    const b = el('button', 'upgrade-btn gate-btn');
    b.type = 'button';
    b.innerHTML = `<i class="ph ph-crown" aria-hidden="true"></i><span>Upgrade to Pro — ${inr(amount)}/month</span>`;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await window.auth.subscribe(); } finally { b.disabled = false; }
    });
    return b;
  }

  function render() {
    const { phase, allowed, status, authMode, email, name, message, online, signedIn, reason, trialDaysLeft } = state;
    const amount = state.planAmountInr || 999;
    if (allowed) {
      gate.hidden = true;
      document.body.classList.remove('locked');
      document.body.classList.remove('gate-plans');
      return;
    }
    gate.hidden = false;
    document.body.classList.add('locked');

    const showingPlans = phase === 'signin' && !chosenPlan;
    document.body.classList.toggle('gate-plans', showingPlans);

    const actions = $('gate-actions');
    actions.replaceChildren();
    let title = 'Checking access…';
    let msg = message || '';
    let icon = ICONS.loading;
    let iconClass = '';

    if (phase === 'loading') {
      if (!msg) msg = 'Connecting to the access server…';
    } else if (phase === 'signin' && showingPlans) {
      // Pricing screen — pick a plan, then sign in.
      title = 'Choose your plan';
      if (!msg) msg = 'Start with a 7-day free trial, or go Pro for unlimited access.';
      const grid = el('div', 'plan-grid');
      grid.append(
        planCard({
          id: 'trial', name: 'Free trial', price: '₹0', per: '/ 7 days',
          features: ['Full access for 7 days', 'Live captions → ChatGPT', 'Stealth, screen-share safe'],
          cta: 'Start free trial',
        }),
        planCard({
          id: 'pro', name: 'Pro', price: inr(amount), per: '/ month', featured: true,
          features: ['Everything in the trial', 'Unlimited, ongoing access', 'Priority updates & support'],
          cta: 'Continue with Pro',
        }),
      );
      actions.append(grid);
    } else if (phase === 'signin') {
      // A plan is chosen → sign in for it.
      title = 'Welcome to A2solveX';
      icon = ICONS.signin;
      if (!msg) {
        msg = chosenPlan === 'pro'
          ? `You'll set up Pro (${inr(amount)}/month) right after signing in.`
          : 'Your 7-day free trial starts the moment you sign in.';
      }
      if (authMode === 'google') {
        actions.append(googleButton(chosenPlan));
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
          if (e) await window.auth.signInDev(e, nameIn.value.trim(), chosenPlan);
        });
        emailIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
        actions.append(emailIn, nameIn, go);
      }
      actions.append(button('‹ Choose a different plan', 'linklike gate-btn', () => { chosenPlan = null; render(); }));
    } else if (phase === 'locked') {
      if (status === 'removed') {
        title = 'Removed'; icon = ICONS.banned;
        if (!msg) msg = 'This tool has been removed by your administrator.';
      } else if (status === 'banned' || reason === 'banned') {
        title = 'Access revoked'; icon = ICONS.banned;
        if (!msg) msg = 'Your access has been disabled. Contact your administrator.';
      } else if (reason === 'trial_expired') {
        title = 'Your free trial has ended'; icon = ICONS.upgrade;
        if (!msg) msg = `Upgrade to Pro to keep using A2solveX — ${inr(amount)}/month, cancel anytime.`;
        actions.append(upgradeButton(amount));
      } else if (reason === 'payment_required') {
        title = 'Activate A2solveX Pro'; icon = ICONS.upgrade;
        if (!msg) msg = `Complete your ${inr(amount)}/month subscription to unlock the tool.`;
        actions.append(upgradeButton(amount));
      } else if (reason === 'device_mismatch') {
        title = 'Already in use on another device'; icon = ICONS.device;
        const where = state.boundDeviceName ? ` (${state.boundDeviceName})` : '';
        if (!msg) msg = `This account is already active on another computer${where}. One account works on one device at a time — move it to this computer, or sign out.`;
        actions.append(button('Use on this device instead', 'primary-button gate-btn', () => window.auth.claimDevice()));
        actions.append(button('Sign out', 'linklike gate-btn', () => window.auth.signOut()));
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

    if (phase === 'locked') iconClass = ICON_CLASS[reason] || ICON_CLASS[status] || 'neutral';

    $('gate-title').textContent = title;
    $('gate-message').textContent = msg;
    const iconEl = $('gate-icon');
    iconEl.hidden = phase === 'signin';
    iconEl.className = 'auth-icon' + (iconClass ? ' ' + iconClass : '');
    iconEl.innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i>`;

    // Stealth reassurance on the welcome / loading / pricing screens.
    $('gate-shield').hidden = !(phase === 'signin' || phase === 'loading');

    if (signedIn && phase !== 'signin') {
      actions.append(button('Sign out', 'secondary-button gate-btn', () => window.auth.signOut()));
    }
    let foot = '';
    if (email) {
      foot = `Signed in as ${email}${name ? ` (${name})` : ''}${online === false ? ' · offline' : ''}`;
    } else if (allowed === false && state.plan === 'trial' && typeof trialDaysLeft === 'number') {
      foot = `Free trial · ${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} left`;
    }
    $('gate-foot').textContent = foot;
  }

  $('gate-close').addEventListener('click', () => window.privacy.controlWindow('close'));
  $('gate-compact').addEventListener('click', () => window.privacy.toggleCompact());
  // Flip the gate's compact button between Collapse and Expand as the bar toggles.
  window.privacy.onCompactChanged?.((isCompact) => {
    const b = $('gate-compact');
    if (!b) return;
    b.title = isCompact ? 'Expand' : 'Compact bar';
    b.setAttribute('aria-label', b.title);
    const i = b.querySelector('i');
    if (i) i.className = `ph ${isCompact ? 'ph-arrows-out-simple' : 'ph-arrows-in-simple'}`;
  });
  // The gate covers the whole window, so it needs its own minimize/maximize — the
  // real title-bar controls are underneath it and unreachable until signed in.
  $('gate-minimize')?.addEventListener('click', () => window.privacy.controlWindow('minimize'));
  const gateMax = $('gate-maximize');
  gateMax?.addEventListener('click', () => window.privacy.controlWindow('maximize'));
  window.privacy.onWindowState?.((s) => {
    if (!gateMax) return;
    const isMax = !!(s && s.maximized);
    gateMax.querySelector('i').className = `ph ${isMax ? 'ph-copy' : 'ph-square'}`;
    gateMax.title = isMax ? 'Restore' : 'Maximize';
    gateMax.setAttribute('aria-label', isMax ? 'Restore' : 'Maximize');
  });

  window.auth.onAuthState((s) => {
    if (s && s.phase === 'signin' && !s.signedIn && prevSignedIn) chosenPlan = null;
    prevSignedIn = !!(s && s.signedIn);
    state = s;
    render();
  });
  window.auth.getState().then((s) => { if (s) { state = s; prevSignedIn = !!s.signedIn; } render(); }).catch(render);
  render();
})();
