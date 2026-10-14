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
let captionFeedEnabled = localStorage.getItem('captionFeedChat') === '1';
// Live caption → ChatGPT composer. The assembler turns the interim/final event
// stream into the full text the box should show; we only push it while the
// ChatGPT tab is the active view (so focusing it never steals the keyboard from
// the other tabs), throttled to coalesce rapid interim updates.
const feed = window.createFeedAssembler();
let feedDesired = '';
let feedSendTimer = null;

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
  if (view === 'ai') ensureChatView().then(scheduleComposerPush);
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
// The minus control switches to the compact floating bar. In compact mode it
// becomes the expand control so the same button returns to the main window.
$('minimize-button').addEventListener('click', () => window.privacy.toggleCompact());
document.querySelectorAll('[data-window="close"]').forEach((button) => {
  button.addEventListener('click', () => window.privacy.controlWindow('close'));
});

window.privacy.onCompactChanged((isCompact) => {
  compact = isCompact;
  document.body.classList.toggle('compact', compact);
  const button = $('minimize-button');
  button.setAttribute('aria-label', compact ? 'Expand window' : 'Compact bar');
  button.querySelector('i').className = `ph ${compact ? 'ph-arrows-out-simple' : 'ph-minus'}`;
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
    await ensureChatView();
  }
}
$('feed-captions').addEventListener('change', (event) => setFeedEnabled(event.target.checked));
$('new-chat').addEventListener('click', () => window.privacy.newChat());
$('reload-chat').addEventListener('click', () => window.privacy.reloadChat());
$('external-chat').addEventListener('click', () => window.privacy.openChatExternal());

// Push the latest assembled transcript to the ChatGPT composer — but only while
// the ChatGPT tab is the active view (focusing a hidden view would steal the
// keyboard from other tabs), throttled so interim-update bursts coalesce.
function scheduleComposerPush() {
  if (!captionFeedEnabled || !chatLoaded || currentView !== 'ai') return;
  if (feedSendTimer) return;
  feedSendTimer = setTimeout(() => {
    feedSendTimer = null;
    window.privacy.setChatComposer(feedDesired);
  }, 140);
}
document.addEventListener('caption:update', (event) => {
  if (!captionFeedEnabled) return;
  feedDesired = feed.update(event.detail || {});
  if (!chatLoaded) { ensureChatView().then(scheduleComposerPush); return; }
  scheduleComposerPush();
});
document.addEventListener('caption:cleared', () => {
  feed.reset();
  feedDesired = '';
  scheduleComposerPush();
});

window.privacy.onChatState((state) => {
  chatOnGpt = Boolean(state && state.onChatGpt);
  if (state && state.ready) chatLoaded = true;
  if (currentView === 'ai') setSubtitle(chatSubtitle());
});
$('profile-button').addEventListener('click', () => {
  $('profile-status').textContent = 'Google Docs access follows the shared link.';
  $('profile-menu').hidden = !$('profile-menu').hidden;
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
