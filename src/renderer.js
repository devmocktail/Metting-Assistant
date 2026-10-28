const $ = (id) => document.getElementById(id);
const navItems = [...document.querySelectorAll('.nav-item')];
const documentCanvas = $('document-canvas');
const documentFallback = $('document-fallback');
const chatCanvas = $('chat-canvas');
let unlocked = false;
let documentLoaded = false;
let compact = false;
let currentView = 'document';
let chatLoaded = false;
let chatOnGpt = false;
let captionFeedEnabled = localStorage.getItem('captionFeedChat') !== '0';
// Live caption → ChatGPT composer. The assembler turns the interim/final event
// stream into the full text the box should show; we only push it while the
// ChatGPT tab is the active view (so focusing it never steals the keyboard from
// the other tabs), throttled to coalesce rapid interim updates.
const feed = window.createFeedAssembler();
let feedDesired = '';
let feedSendTimer = null;
let lastPushed = null;  // actual composer text after our last write (null = unknown/force)
let pushing = false;
let feedDirty = false;  // a new caption arrived while a push was in flight
let pushFails = 0;      // consecutive failed/hung pushes, for retry backoff

const viewDetails = {
  document: { title: '[Document title]', subtitle: 'Google Doc · Waiting for link', icon: 'ph-file-text' },
  captions: { title: 'Captions', subtitle: 'Live captions · Audio off', icon: 'ph-closed-captioning' },
  ai: { title: 'ChatGPT', subtitle: 'Browser · Sign in to begin', icon: 'ph-chat-circle-dots' },
};

// The status dot sits beside #content-subtitle in the markup; only the text changes.
function setSubtitle(text) {
  $('content-subtitle').textContent = text;
}

function updateDocumentBounds() {
  if (!unlocked || !documentLoaded || currentView !== 'document' || compact) {
    window.privacy.setDocumentBounds({ x: 0, y: 0, width: 0, height: 0 });
    return;
  }
  const rect = documentCanvas.getBoundingClientRect();
  window.privacy.setDocumentBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
}

function updateChatBounds() {
  if (!unlocked || !chatLoaded || currentView !== 'ai' || compact) {
    window.privacy.setChatBounds({ x: 0, y: 0, width: 0, height: 0 });
    return;
  }
  const rect = chatCanvas.getBoundingClientRect();
  window.privacy.setChatBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
}

// Creates and loads the ChatGPT view on demand (first visit, or when caption
// feeding is switched on from another tab).
async function ensureChatView() {
  if (chatLoaded) return true;
  $('chat-loading').hidden = false;
  const result = await window.privacy.ensureChat();
  $('chat-loading').hidden = true;
  if (!result.loaded) {
    if (currentView === 'ai') setSubtitle(result.error || 'ChatGPT could not be opened.');
    return false;
  }
  chatLoaded = true;
  chatOnGpt = Boolean(result.onChatGpt);
  updateChatBounds();
  return true;
}

function setCurrentView(view) {
  currentView = view;
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  for (const name of Object.keys(viewDetails)) $(`${name}-view`).hidden = name !== view;

  const details = viewDetails[view];
  $('content-title').textContent = view === 'document' && documentLoaded ? $('content-title').dataset.documentTitle : details.title;
  setSubtitle(view === 'ai' ? chatSubtitle() : details.subtitle);
  $('content-icon').innerHTML = `<i class="ph ${details.icon}" aria-hidden="true"></i>`;
  $('document-form').hidden = view !== 'document';
  $('chat-controls').hidden = view !== 'ai';
  if (view === 'ai') ensureChatView().then(() => scheduleComposerPush());
  updateDocumentBounds();
  updateChatBounds();
}

function chatSubtitle() {
  if (!unlocked) return 'Browser · Protected view unavailable';
  if (!chatLoaded) return 'Browser · Opening…';
  if (!chatOnGpt) return 'Browser · Sign in to ChatGPT';
  return captionFeedEnabled ? 'ChatGPT · Captions feed the prompt' : 'ChatGPT · Ready';
}

async function openDocument(rawUrl) {
  const input = $('document-url');
  const openButton = $('open-document');
  openButton.disabled = true;
  openButton.textContent = 'Opening';
  const result = await window.privacy.loadPublicDocument(rawUrl.trim());
  openButton.disabled = false;
  openButton.textContent = 'Open';

  if (!result.loaded) {
    setSubtitle(result.error);
    documentLoaded = false;
    documentFallback.hidden = false;
    updateDocumentBounds();
    return;
  }

  documentLoaded = true;
  input.value = result.url;
  localStorage.setItem('publicDocUrl', result.url);
  $('content-title').dataset.documentTitle = result.title;
  $('content-title').textContent = result.title;
  setSubtitle('Google Doc · Live');
  $('reload-document').disabled = false;
  $('external-document').disabled = false;
  documentFallback.hidden = true;
  setCurrentView('document');
}

navItems.forEach((item) => item.addEventListener('click', () => setCurrentView(item.dataset.view)));
document.addEventListener('captions:status', event => {
  viewDetails.captions.subtitle = `Live captions · ${event.detail}`;
  if (currentView === 'captions') setCurrentView('captions');
});
$('audio-card').addEventListener('click', () => setCurrentView('captions'));
$('document-form').addEventListener('submit', (event) => {
  event.preventDefault();
  openDocument($('document-url').value);
});
// Manual window dragging from a bar. Grabbing empty bar area moves the window;
// interactive controls are excluded so they still click. Double-click toggles maximize.
const DRAG_EXCLUDE = 'button, input, select, textarea, a, [role="button"], kbd, .window-controls, .auth-top-actions, .profile-menu';
function makeDraggable(handle) {
  if (!handle) return;
  handle.addEventListener('mousedown', async (event) => {
    if (event.button !== 0 || event.target.closest(DRAG_EXCLUDE)) return;
    const origin = await window.privacy.windowDragStart();
    if (!origin) return;
    const baseX = event.screenX;
    const baseY = event.screenY;
    let pending = null;
    let raf = 0;
    const flush = () => { raf = 0; if (pending) { window.privacy.windowDragMove(pending); pending = null; } };
    const onMove = (ev) => { pending = { dx: ev.screenX - baseX, dy: ev.screenY - baseY }; if (!raf) raf = requestAnimationFrame(flush); };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      if (raf) cancelAnimationFrame(raf);
      flush();
      window.privacy.windowDragEnd();
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    event.preventDefault();
  });
  handle.addEventListener('dblclick', (event) => {
    if (compact || event.target.closest(DRAG_EXCLUDE)) return;
    window.privacy.controlWindow('maximize');
  });
}
makeDraggable(document.querySelector('.topbar'));
makeDraggable(document.querySelector('.auth-gate-top'));

// Real window controls plus the compact floating-bar toggle.
$('compact-button').addEventListener('click', () => window.privacy.toggleCompact());
$('minimize-button').addEventListener('click', () => window.privacy.controlWindow('minimize'));
function setMaxButton(isMax) {
  const btn = $('maximize-button');
  if (!btn) return;
  btn.querySelector('i').className = `ph ${isMax ? 'ph-copy' : 'ph-square'}`;
  btn.title = isMax ? 'Restore' : 'Maximize';
  btn.setAttribute('aria-label', isMax ? 'Restore' : 'Maximize');
}
// Fire-and-forget: the icon is updated from the window's real maximize/unmaximize
// events (below), so it stays correct even if the state changed via a drag-bar
// double-click or Windows Snap rather than this button.
$('maximize-button').addEventListener('click', () => window.privacy.controlWindow('maximize'));
window.privacy.onWindowState((state) => setMaxButton(!!(state && state.maximized)));
document.querySelectorAll('[data-window="close"]').forEach((button) => {
  button.addEventListener('click', () => window.privacy.controlWindow('close'));
});

window.privacy.onCompactChanged((isCompact) => {
  compact = isCompact;
  document.body.classList.toggle('compact', compact);
  const button = $('compact-button');
  button.setAttribute('aria-label', compact ? 'Expand window' : 'Compact bar');
  button.title = compact ? 'Expand window' : 'Compact bar';
  button.querySelector('i').className = `ph ${compact ? 'ph-arrows-out-simple' : 'ph-arrows-in-simple'}`;
  updateDocumentBounds();
  updateChatBounds();
});

$('reload-document').addEventListener('click', async () => {
  const ok = await window.privacy.reloadDocument();
  if (ok) setSubtitle('Google Doc · Refreshing');
});
$('external-document').addEventListener('click', () => window.privacy.openDocumentExternal());

// ChatGPT browser controls.
function syncFeedToggle() {
  $('feed-captions').checked = captionFeedEnabled;
  $('feed-toggle').classList.toggle('on', captionFeedEnabled);
  if (currentView === 'ai') setSubtitle(chatSubtitle());
}
async function setFeedEnabled(on) {
  captionFeedEnabled = Boolean(on);
  localStorage.setItem('captionFeedChat', captionFeedEnabled ? '1' : '0');
  syncFeedToggle();
  if (captionFeedEnabled) {
    // Start a fresh transcript and make sure the view exists.
    feed.reset();
    feedDesired = '';
    feedDirty = false;
    lastPushed = null;
    pushFails = 0;
    await ensureChatView();
  }
}
$('feed-captions').addEventListener('change', (event) => setFeedEnabled(event.target.checked));
$('new-chat').addEventListener('click', () => window.privacy.newChat());
$('reload-chat').addEventListener('click', () => window.privacy.reloadChat());
$('external-chat').addEventListener('click', () => window.privacy.openChatExternal());

// Capture button (in the ChatGPT controls): grab the whole screen and attach it to
// the ChatGPT prompt as an image. We are already on the ChatGPT tab when this shows.
$('chat-capture').addEventListener('click', async () => {
  const button = $('chat-capture');
  if (button.disabled) return;
  button.disabled = true;
  setSubtitle('Capturing your screen…');
  const ready = await ensureChatView();
  if (!ready) {
    button.disabled = false;
    setSubtitle('ChatGPT could not be opened. Try again in a moment.');
    return;
  }
  const res = await window.privacy.captureScreenToChat();
  button.disabled = false;
  if (!res || !res.ok) {
    setSubtitle((res && res.error) || 'Could not capture the screen.');
    return;
  }
  setSubtitle('Screenshot added to the prompt — review and press Send');
});

// Push the latest assembled transcript to the ChatGPT composer — but only while
// the ChatGPT tab is the active view (focusing a hidden view would steal the
// keyboard from other tabs), throttled so interim-update bursts coalesce.
//
// The loop is self-healing: a hung injection can never jam it (every push races a
// timeout), and it always converges — any caption that arrives mid-push is picked
// up the moment the push finishes, so the box never ends on a stale question.
function scheduleComposerPush(delay = 140) {
  if (!captionFeedEnabled || !chatLoaded || currentView !== 'ai') return;
  if (pushing || feedSendTimer) return;
  feedSendTimer = setTimeout(runComposerPush, delay);
}

async function runComposerPush() {
  feedSendTimer = null;
  if (pushing || !captionFeedEnabled || !chatLoaded || currentView !== 'ai') return;
  pushing = true;
  feedDirty = false;            // we are about to flush the current transcript
  const target = feedDesired;
  let res = null;
  try {
    // Race a timeout so a navigating/hung ChatGPT view can't leave `pushing` stuck
    // true forever (which used to silently kill the feed for the rest of the session).
    res = await Promise.race([
      window.privacy.setChatComposer({ text: target, prev: lastPushed }),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 4000)),
    ]);
  } catch { res = null; }
  pushing = false;

  if (res && res.userEdited) {
    // The user is typing their own prompt — drop our transcript so we don't shove
    // stale captions back over them; `current` is what they actually have.
    feed.reset();
    feedDesired = '';
    feedDirty = false;
    lastPushed = String(res.current || '');
    pushFails = 0;
  } else if (res && res.emptied) {
    // The question was sent (or the box cleared) — start the next one perfectly clean.
    feed.reset();
    feedDesired = '';
    feedDirty = false;
    lastPushed = '';
    pushFails = 0;
  } else if (res && res.ok) {
    lastPushed = String(res.current != null ? res.current : target);
    pushFails = 0;
  } else {
    // Couldn't reach/find the composer (view navigating, timed out) — retry, backing off.
    pushFails = Math.min(pushFails + 1, 15);
  }

  // Converge: re-run if newer words arrived during the push, or the write failed.
  const writeFailed = !(res && (res.ok || res.userEdited || res.emptied));
  if (feedDirty || writeFailed) {
    scheduleComposerPush(writeFailed ? Math.min(300 * pushFails, 3000) : 50);
  }
}

document.addEventListener('caption:update', (event) => {
  if (!captionFeedEnabled) return;
  feedDesired = feed.update(event.detail || {});
  feedDirty = true;
  if (!chatLoaded) { ensureChatView().then(() => scheduleComposerPush()); return; }
  scheduleComposerPush();
});
// Clearing the Captions tab clears only that transcript view — it deliberately
// does NOT touch the ChatGPT prompt. Clear the ChatGPT prompt there to reset it.

window.privacy.onChatState((state) => {
  chatOnGpt = Boolean(state && state.onChatGpt);
  if (state && state.ready) chatLoaded = true;
  if (currentView === 'ai') setSubtitle(chatSubtitle());
});
// Account menu: show who is signed in + their plan, and offer sign out.
let authInfo = null;
function renderProfile() {
  $('profile-name').textContent = (authInfo && (authInfo.name || authInfo.email)) || 'Account';
  const email = (authInfo && authInfo.email) || '';
  $('profile-email').textContent = email;
  $('profile-email').hidden = !email;
  let plan = '';
  if (authInfo) {
    if (authInfo.admin) plan = 'Admin access';
    else if (authInfo.plan === 'pro') plan = 'Pro · ₹999/month';
    else if (authInfo.plan === 'trial' && typeof authInfo.trialDaysLeft === 'number') {
      plan = `Free trial · ${authInfo.trialDaysLeft} day${authInfo.trialDaysLeft === 1 ? '' : 's'} left`;
    } else if (authInfo.plan === 'trial') plan = 'Free trial';
  }
  $('profile-plan').textContent = plan;
  $('profile-plan').hidden = !plan;
}
if (window.auth) {
  window.auth.getState().then((s) => { authInfo = s; renderProfile(); }).catch(() => {});
  window.auth.onAuthState((s) => { authInfo = s; renderProfile(); });
}
$('profile-button').addEventListener('click', () => {
  renderProfile();
  $('profile-menu').hidden = !$('profile-menu').hidden;
});
$('signout-button').addEventListener('click', async () => {
  $('profile-menu').hidden = true;
  try { await window.auth.signOut(); } catch { /* the gate reappears on the state change */ }
});

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#profile-button, #profile-menu')) $('profile-menu').hidden = true;
});

window.privacy.onDocumentTitle((title) => {
  if (!title || title === 'Google Docs') return;
  $('content-title').dataset.documentTitle = title;
  if (currentView === 'document') $('content-title').textContent = title;
});
function updateEmbeddedBounds() {
  updateDocumentBounds();
  updateChatBounds();
}
window.privacy.onDocumentLayoutNeeded(updateEmbeddedBounds);
new ResizeObserver(updateDocumentBounds).observe(documentCanvas);
new ResizeObserver(updateChatBounds).observe(chatCanvas);
document.querySelector('.workspace-layout').addEventListener('scroll', updateEmbeddedBounds, true);
window.addEventListener('resize', updateEmbeddedBounds);

$('opacity').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  window.privacy.setOpacity(value / 100);
  $('opacity-value').textContent = `${value}%`;
});

window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const shortcutViews = { '1': 'document', '2': 'captions', '3': 'ai' };
  if (shortcutViews[event.key]) {
    event.preventDefault();
    setCurrentView(shortcutViews[event.key]);
  }
});

async function initialize() {
  const state = await window.privacy.capability();
  unlocked = Boolean(state.canUnlock);
  syncFeedToggle();
  const savedDocUrl = localStorage.getItem('publicDocUrl');
  if (savedDocUrl) {
    $('document-url').value = savedDocUrl;
    if (unlocked) openDocument(savedDocUrl);
    else setSubtitle(state.detail);
  }
  // Resume feeding captions into ChatGPT if it was left on last session.
  if (unlocked && captionFeedEnabled) ensureChatView();
}
initialize().catch(() => {
  setSubtitle('Capture protection could not be confirmed');
});
