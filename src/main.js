const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, screen, desktopCapturer, clipboard } = require('electron');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { CaptionService } = require('./captions');
const { createAuthClient } = require('./auth/authClient');
const { runLoopbackAuth } = require('./auth/oauthGoogle');

// Installed copies keep data (settings, downloaded models) where development runs
// do, %APPDATA%\private-meeting-overlay, whatever the product name says.
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'private-meeting-overlay'));
}

let overlayWindow;
let documentView;
let chatView;
let chatReady = false;
let privacyUnlocked = false;
let compactMode = false;
let windowDragOrigin = null; // window [x,y] captured when a manual drag starts
let initialWorkArea;
let expandedBounds = { width: 1440, height: 900 };
let activeDocumentUrl = null;
let captionService;
let authClient;
let authState = { phase: 'loading', allowed: false };
// Fail closed: the tool stays locked until the backend confirms the signed-in
// account is approved.
let authAllowed = false;
const hiddenViewBounds = { x: 0, y: 0, width: 0, height: 0 };

function normalizePublicDocsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' || !['docs.google.com', 'www.docs.google.com'].includes(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/(?:edit|preview|view))?\/?$/);
    if (!match) return null;
    // Use the live Docs editor client in the document's normal view-only mode.
    // Drive permissions must give the app's visitor Viewer access.
    return `https://docs.google.com/document/d/${match[1]}/edit`;
  } catch {
    return null;
  }
}

function isAllowedDocsNavigation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' &&
      ['docs.google.com', 'www.docs.google.com', 'accounts.google.com'].includes(url.hostname);
  } catch {
    return false;
  }
}

// The embedded ChatGPT browser. Its session is kept in a persistent partition so
// the sign-in survives restarts, separate from the Docs view's session.
const CHAT_PARTITION = 'persist:assistant-chat';
const CHAT_HOME_URL = 'https://chatgpt.com/';
// Navigation stays on ChatGPT/OpenAI and the common sign-in providers it uses.
// Anything else opens in the user's real browser instead of inside the overlay.
const CHAT_ALLOWED_SUFFIXES = [
  'chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com',
  'google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com', 'recaptcha.net',
  'microsoftonline.com', 'microsoft.com', 'live.com', 'office.com',
  'apple.com', 'icloud.com', 'auth0.com', 'cloudflare.com',
];

function isAllowedChatNavigation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return CHAT_ALLOWED_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function isChatGptUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com';
  } catch {
    return false;
  }
}

// Sets ChatGPT's message composer to the live transcript, without sending it.
// To stay cheap under rapid interim updates, it rewrites only the tail that
// changed (common-prefix diff), so growing text is near-constant work. ChatGPT
// uses a contenteditable ProseMirror editor (#prompt-textarea); older builds use
// a <textarea>. Both are handled, newest first.
function composerSetScript(fullText, prevText) {
  const payload = JSON.stringify(String(fullText));
  const prevPayload = prevText === null || prevText === undefined ? 'null' : JSON.stringify(String(prevText));
  // Every path returns the editor's ACTUAL text as `current`, so the renderer
  // tracks what the box really holds (not what we meant to type). That stops
  // ProseMirror's own normalization from looking like a user edit next time.
  return `(() => {
    const text = ${payload};
    const prev = ${prevPayload};

    function classify(before) {
      if (before === text) return 'same';
      // Emptied after we had filled it => the message was sent (or the box was
      // cleared). Signal a fresh start instead of re-stuffing the old question.
      if (before === '' && prev !== null && prev !== '') return 'emptied';
      // Holds text we did not write => the user is typing their own prompt.
      if (before !== '' && prev !== null && before !== prev) return 'userEdited';
      return 'write';
    }

    const editor = document.querySelector('#prompt-textarea[contenteditable="true"]')
      || document.querySelector('div.ProseMirror[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"]');
    if (editor) {
      const before = editor.textContent || '';
      const verdict = classify(before);
      if (verdict === 'same') return { ok: true, current: before };
      if (verdict === 'emptied') return { ok: true, emptied: true, current: '' };
      if (verdict === 'userEdited') return { ok: true, userEdited: true, current: before };

      function locate(root, offset) {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let pos = 0, n;
        while ((n = w.nextNode())) {
          const len = n.nodeValue.length;
          if (offset <= pos + len) return { node: n, off: offset - pos };
          pos += len;
        }
        return { node: root, off: root.childNodes.length };
      }
      function replaceRange(from, to, insert) {
        editor.focus();
        const a = locate(editor, from);
        const b = locate(editor, to);
        const sel = window.getSelection();
        const range = document.createRange();
        try { range.setStart(a.node, a.off); range.setEnd(b.node, b.off); }
        catch (e) { range.selectNodeContents(editor); }
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, insert);
      }
      // Cheap path: rewrite only the changed tail (common-prefix diff) so growing
      // text is near-constant work under rapid interim updates.
      let i = 0;
      const max = Math.min(before.length, text.length);
      while (i < max && before.charCodeAt(i) === text.charCodeAt(i)) i++;
      replaceRange(i, before.length, text.slice(i));

      let after = editor.textContent || '';
      // Self-heal: if the incremental edit did not land the exact text (stale
      // selection after a ProseMirror re-render, a dropped keystroke), rewrite the
      // whole box once so a half-entered question corrects itself instead of sticking.
      if (after !== text) {
        replaceRange(0, after.length, text);
        after = editor.textContent || '';
      }
      return { ok: true, current: after };
    }

    const area = document.querySelector('textarea#prompt-textarea')
      || document.querySelector('main textarea')
      || document.querySelector('textarea');
    if (area) {
      const before = area.value || '';
      const verdict = classify(before);
      if (verdict === 'same') return { ok: true, current: before };
      if (verdict === 'emptied') return { ok: true, emptied: true, current: '' };
      if (verdict === 'userEdited') return { ok: true, userEdited: true, current: before };
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), 'value');
      if (descriptor && descriptor.set) descriptor.set.call(area, text); else area.value = text;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, current: area.value || '' };
    }
    return { ok: false };
  })()`;
}

// Appends one line per screen-capture attempt to userData\code-capture.log, so a
// failure on a packaged build (no DevTools) can still be diagnosed.
function logCapture(info) {
  try {
    const line = new Date().toISOString() + ' ' + JSON.stringify(info) + '\n';
    fs.appendFileSync(path.join(app.getPath('userData'), 'code-capture.log'), line);
  } catch { /* logging must never break capture */ }
}

// Attaches a screenshot to ChatGPT's composer as if it were pasted. A synthetic
// paste event carries the File reliably (verified in this Chromium), and unlike a
// real Ctrl+V it does not depend on the embedded view holding OS keyboard focus.
// The data URL is decoded in-page with atob (no fetch) so ChatGPT's CSP can't block it.
// Counts the image-attachment previews ChatGPT shows for a pending upload. Used to
// VERIFY a screenshot actually attached — earlier methods reported success merely
// because the injection ran, while no image ever appeared.
const ATTACHMENT_COUNT_EXPR = `(() => {
  try {
    const imgs = document.querySelectorAll('img[src^="blob:"]').length;
    const form = document.querySelector('form');
    const chips = form ? form.querySelectorAll('img, [role="img"], button[aria-label*="remove" i], button[aria-label*="delete" i]').length : 0;
    return imgs * 1000 + chips; // blob imgs are the strong signal; chips are a weak tiebreaker
  } catch (e) { return 0; }
})()`;

// Focuses ChatGPT's composer and drops a caret inside it. Returns whether a composer
// was found at all (so a not-signed-in state gives a clear message).
const COMPOSER_FOCUS_SCRIPT = `(() => {
  const el = document.querySelector('#prompt-textarea[contenteditable="true"]')
    || document.querySelector('div.ProseMirror[contenteditable="true"]')
    || document.querySelector('[contenteditable="true"]')
    || document.querySelector('textarea#prompt-textarea')
    || document.querySelector('main textarea')
    || document.querySelector('textarea');
  if (!el) return false;
  try {
    el.focus();
    if (el.isContentEditable) {
      const r = document.createRange();
      r.selectNodeContents(el); r.collapse(false);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  } catch (e) {}
  return true;
})()`;

// Decodes the data URL into a File + DataTransfer in-page (atob, no fetch → no CSP issue).
function imageToDataTransferPreamble(dataUrl) {
  const payload = JSON.stringify(String(dataUrl));
  return `const durl = ${payload};
    const comma = durl.indexOf(',');
    const mime = ((durl.slice(0, comma).match(/data:([^;]+)/)) || [])[1] || 'image/png';
    const bin = atob(durl.slice(comma + 1));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const makeDT = () => { const d = new DataTransfer(); d.items.add(new File([new Blob([arr], { type: mime })], 'screenshot-' + Date.now() + '.png', { type: mime })); return d; };`;
}

// Fallback injectors, used only if the real Ctrl+V keystroke does not attach.
function fileInputInjectScript(dataUrl) {
  return `(() => { try {
    ${imageToDataTransferPreamble(dataUrl)}
    const inputs = Array.prototype.slice.call(document.querySelectorAll('input[type=file]'));
    const input = inputs.filter(function (i) { return (i.accept || '').toLowerCase().indexOf('image') !== -1; })[0] || inputs[0] || null;
    if (!input) return false;
    input.value = '';
    input.files = makeDT().files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch (e) { return false; } })()`;
}
function syntheticPasteInjectScript(dataUrl) {
  return `(() => { try {
    ${imageToDataTransferPreamble(dataUrl)}
    const el = document.querySelector('#prompt-textarea[contenteditable="true"]')
      || document.querySelector('div.ProseMirror[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"]');
    if (!el) return false;
    el.focus();
    try { el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: makeDT() })); } catch (e) {}
    try {
      const dt = makeDT();
      el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    } catch (e) {}
    return true;
  } catch (e) { return false; } })()`;
}

function createDocumentView() {
  if (documentView || !overlayWindow) return documentView;
  documentView = new WebContentsView({
    webPreferences: {
      partition: 'meeting-doc-view',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  overlayWindow.contentView.addChildView(documentView);
  documentView.setBounds(hiddenViewBounds);

  documentView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  documentView.webContents.on('did-finish-load', () => {
    // Match the app shell: a plain arrow cursor everywhere in the embedded doc.
    documentView?.webContents.insertCSS('*, *::before, *::after { cursor: default !important; }').catch(() => {});
  });
  documentView.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedDocsNavigation(url)) event.preventDefault();
  });
  documentView.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedDocsNavigation(url)) event.preventDefault();
  });
  documentView.webContents.on('will-attach-webview', (event) => event.preventDefault());
  documentView.webContents.on('render-process-gone', () => {
    documentView?.setBounds(hiddenViewBounds);
  });
  return documentView;
}

function notifyChatState() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !chatView) return;
  const url = chatView.webContents.getURL() || '';
  overlayWindow.webContents.send('chat:state', { ready: chatReady, url, onChatGpt: isChatGptUrl(url) });
}

function createChatView() {
  if (chatView || !overlayWindow) return chatView;
  chatView = new WebContentsView({
    webPreferences: {
      partition: CHAT_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  overlayWindow.contentView.addChildView(chatView);
  chatView.setBounds(hiddenViewBounds);

  // Sign-in flows (e.g. "Continue with Google") open popups; allow them for the
  // trusted providers in the same session, and send anything else to the real
  // browser. Child popups stay capture-protected like the overlay.
  chatView.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || isAllowedChatNavigation(url)) {
      return {
        action: 'allow',
        overrides: {
          webPreferences: { partition: CHAT_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  chatView.webContents.on('did-create-window', (childWindow) => {
    try { childWindow.setContentProtection(true); } catch {}
    childWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedChatNavigation(url)) {
        return { action: 'allow', overrides: { webPreferences: { partition: CHAT_PARTITION } } };
      }
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
  });
  chatView.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedChatNavigation(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  chatView.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedChatNavigation(url)) event.preventDefault();
  });
  chatView.webContents.on('will-attach-webview', (event) => event.preventDefault());
  chatView.webContents.on('render-process-gone', () => {
    chatReady = false;
    chatView?.setBounds(hiddenViewBounds);
    notifyChatState();
  });
  chatView.webContents.on('did-finish-load', () => { chatReady = true; notifyChatState(); });
  chatView.webContents.on('did-navigate', () => notifyChatState());
  chatView.webContents.on('did-navigate-in-page', () => notifyChatState());
  return chatView;
}

function clampToContent(bounds) {
  if (!overlayWindow || !bounds || typeof bounds !== 'object') return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  const content = overlayWindow.getContentBounds();
  const safeX = Math.max(0, Math.min(Math.round(x), content.width));
  const safeY = Math.max(0, Math.min(Math.round(y), content.height));
  const safeWidth = Math.max(0, Math.min(Math.round(width), content.width - safeX));
  const safeHeight = Math.max(0, Math.min(Math.round(height), content.height - safeY));
  return safeWidth > 0 && safeHeight > 0
    ? { x: safeX, y: safeY, width: safeWidth, height: safeHeight }
    : hiddenViewBounds;
}

function setDocumentBounds(bounds) {
  if (!documentView || !privacyUnlocked || compactMode || !authAllowed) return;
  const rect = clampToContent(bounds);
  if (rect) documentView.setBounds(rect);
}

function setChatBounds(bounds) {
  if (!chatView || !privacyUnlocked || compactMode || !authAllowed) return;
  const rect = clampToContent(bounds);
  if (rect) chatView.setBounds(rect);
}

// --- authentication / gating ---

// The deployed gating backend. Installed copies connect here by default so a
// downloaded build "just works"; override per machine with MEETING_BACKEND_URL
// or a userData/backend.json. Change this one line if the backend moves domains.
const DEFAULT_BACKEND_URL = 'https://a2solvex.a2cloud.in';

// Where the gating backend lives: env override, then a userData/backend.json
// file, then the baked default (localhost while developing from source).
function resolveBackendUrl() {
  if (process.env.MEETING_BACKEND_URL) return process.env.MEETING_BACKEND_URL;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'backend.json'), 'utf8'));
    if (cfg && typeof cfg.backendUrl === 'string' && cfg.backendUrl) return cfg.backendUrl;
  } catch { /* no file → default */ }
  return app.isPackaged ? DEFAULT_BACKEND_URL : 'http://localhost:8787';
}

function createTokenStorage() {
  const file = path.join(app.getPath('userData'), 'auth.json');
  return {
    load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } },
    save(obj) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); } catch { /* best effort */ }
    },
    clear() { try { fs.unlinkSync(file); } catch { /* ignore */ } },
  };
}

// Reacts to every auth-state change: locks/unlocks the tool and tells the
// renderer so it can show or hide the sign-in gate.
let uninstalling = false;

// Admin-triggered remote removal: clear the local session/config immediately,
// then wipe app data, run the installer's uninstaller (installed builds), and
// quit. On the dev/unpacked build there is no uninstaller, so it clears data and
// exits.
function performUninstall() {
  if (uninstalling) return;
  uninstalling = true;
  authAllowed = false;
  documentView?.setBounds(hiddenViewBounds);
  chatView?.setBounds(hiddenViewBounds);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('auth:state', {
      ...authState, phase: 'locked', status: 'removed', allowed: false,
      message: 'This tool has been removed by your administrator.',
    });
  }
  try { if (captionService && captionService.worker) captionService.stop().catch(() => {}); } catch { /* ignore */ }

  const userData = app.getPath('userData');
  for (const f of ['auth.json', 'backend.json']) {
    try { fs.unlinkSync(path.join(userData, f)); } catch { /* best effort */ }
  }

  setTimeout(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* locked files ok */ }
    try {
      const dir = path.dirname(process.execPath);
      const uninstaller = fs.readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f));
      if (app.isPackaged && uninstaller) {
        require('node:child_process').spawn(path.join(dir, uninstaller), ['/S'], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch { /* ignore */ }
    quitting = true;
    app.quit();
    setTimeout(() => app.exit(0), 3000).unref();
  }, 3000);
}

function enforceAuth(state) {
  authState = state;
  if (state.command === 'uninstall') { performUninstall(); return; }
  const allowed = !!state.allowed;
  if (allowed !== authAllowed) {
    authAllowed = allowed;
    if (!allowed) {
      documentView?.setBounds(hiddenViewBounds);
      chatView?.setBounds(hiddenViewBounds);
      if (captionService && captionService.worker) captionService.stop().catch(() => {});
    } else if (overlayWindow && !overlayWindow.isDestroyed()) {
      // Ask the renderer to re-measure and re-show the active embedded view.
      overlayWindow.webContents.send('document:layout-needed');
    }
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('auth:state', state);
}

let backendBase = '';
let paymentWindow = null;

// Opens the backend-hosted Razorpay checkout in its own window. The page verifies
// the payment server-side and signals success by setting its title to "PAID";
// closing (success or cancel) triggers a status recheck so the gate updates.
function openPaymentWindow(url) {
  if (paymentWindow && !paymentWindow.isDestroyed()) {
    paymentWindow.focus();
    paymentWindow.loadURL(url);
    return;
  }
  paymentWindow = new BrowserWindow({
    width: 520,
    height: 700,
    title: 'A2solveX Pro — Payment',
    parent: overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : undefined,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  paymentWindow.setMenuBarVisibility(false);
  try { paymentWindow.setContentProtection(true); } catch { /* capture hint only */ }
  paymentWindow.loadURL(url);
  paymentWindow.webContents.on('page-title-updated', (_e, title) => {
    if (title === 'PAID') {
      authClient && authClient.recheck().catch(() => {});
      setTimeout(() => { if (paymentWindow && !paymentWindow.isDestroyed()) paymentWindow.close(); }, 1800);
    }
  });
  paymentWindow.on('closed', () => {
    paymentWindow = null;
    authClient && authClient.recheck().catch(() => {});
  });
}

// Create a subscription on the backend, then open checkout. Surfaces any error
// to the gate via a transient message on the auth state.
async function startProCheckout() {
  if (!authClient) return { ok: false, error: 'not ready' };
  const res = await authClient.subscribe();
  if (!res.ok) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('auth:state', { ...authClient.getState(), message: res.error || 'Could not start checkout.' });
    }
    return res;
  }
  const payUrl = res.payUrl || ('/pay?sub=' + encodeURIComponent(res.subscriptionId));
  openPaymentWindow(backendBase + payUrl);
  return res;
}

// A stable per-machine id for device binding (one account → one machine). Derived
// from the Windows MachineGuid so copying the app's data folder to another PC does
// not carry the binding; falls back to a persisted random id if that is unreadable.
let cachedDeviceIdentity = null;
function deviceIdentity() {
  if (cachedDeviceIdentity) return cachedDeviceIdentity;
  const crypto = require('node:crypto');
  const name = String(os.hostname() || 'PC').slice(0, 120);
  let seed = '';
  try {
    const out = require('node:child_process')
      .execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid /reg:64', { windowsHide: true, timeout: 4000 })
      .toString();
    const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
    if (m) seed = m[1];
  } catch { /* not Windows, or key unreadable */ }
  if (!seed) {
    try {
      const p = path.join(app.getPath('userData'), 'device.id');
      if (fs.existsSync(p)) seed = fs.readFileSync(p, 'utf8').trim();
      if (!seed) { seed = crypto.randomUUID(); fs.writeFileSync(p, seed); }
    } catch { seed = name; }
  }
  const id = crypto.createHash('sha256').update('a2solvex-device:' + seed).digest('hex');
  cachedDeviceIdentity = { id, name };
  return cachedDeviceIdentity;
}

function setupAuth() {
  backendBase = resolveBackendUrl().replace(/\/+$/, '');
  authClient = createAuthClient({
    backendUrl: backendBase,
    storage: createTokenStorage(),
    heartbeatMs: 120000,
    offlineGraceMs: 600000,
    device: deviceIdentity(),
    onState: enforceAuth,
    runGoogleAuth: ({ clientId }) => runLoopbackAuth({ clientId, openBrowser: (url) => shell.openExternal(url) }),
  });

  ipcMain.handle('auth:get-state', () => (authClient ? authClient.getState() : authState));
  ipcMain.handle('auth:signin-google', async (_event, plan) => {
    const state = await authClient.signInGoogle(plan);
    // Chose Pro → offer checkout immediately after sign-in (trial stays as fallback).
    if (plan === 'pro' && state && state.signedIn) startProCheckout().catch(() => {});
    return state;
  });
  ipcMain.handle('auth:signin-dev', async (_event, payload) => {
    const plan = payload && payload.plan;
    const state = await authClient.signInStub(String((payload && payload.email) || ''), String((payload && payload.name) || ''), plan);
    if (plan === 'pro' && state && state.signedIn) startProCheckout().catch(() => {});
    return state;
  });
  ipcMain.handle('auth:signout', () => authClient.signOut());
  ipcMain.handle('auth:recheck', () => authClient.recheck());
  ipcMain.handle('auth:claim-device', () => authClient.claimDevice());
  ipcMain.handle('billing:subscribe', () => startProCheckout());

  authClient.init().catch(() => {});
}

function privacyCapability() {
  if (process.platform === 'win32') {
    const [major, minor, build] = os.release().split('.').map(Number);
    const supported = major > 10 || (major === 10 && (minor > 0 || build >= 19041));
    return {
      platform: 'Windows',
      supported,
      detail: supported
        ? 'Windows capture exclusion is available on this OS. The active meeting capture path still needs remote-view verification.'
        : 'This Windows version cannot reliably exclude the overlay. Assistance content stays locked.',
    };
  }

  if (process.platform === 'darwin') {
    return {
      platform: 'macOS',
      supported: false,
      detail: 'Some newer screen sharing apps using ScreenCaptureKit can capture protected windows. Assistance content stays locked.',
    };
  }

  return {
    platform: process.platform,
    supported: false,
    detail: 'Electron does not provide content protection on this platform. Assistance content stays locked.',
  };
}

function createOverlay() {
  initialWorkArea = screen.getPrimaryDisplay().workAreaSize;
  expandedBounds = { width: Math.min(1440, initialWorkArea.width), height: Math.min(900, initialWorkArea.height) };
  const capability = privacyCapability();
  overlayWindow = new BrowserWindow({
    width: expandedBounds.width,
    height: expandedBounds.height,
    center: true,
    minWidth: 1024,
    minHeight: 640,
    minimizable: true,
    maximizable: true,
    title: 'Private Meeting Assistant',
    alwaysOnTop: true,
    opacity: 0.94,
    show: false,
    frame: false,
    // Keep the overlay off the Windows taskbar so it does not show a running-window
    // button there. (This is the taskbar only; it has no effect on Task Manager.)
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged, // no DevTools in the shipped build
    },
  });

  // Set before the first paint. This is a platform capture hint, not proof that
  // a particular meeting application's received stream excludes this window.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      overlayWindow.setContentProtection(true);
    } catch (error) {
      console.error('Could not enable Electron content protection:', error);
    }
  }
  // Keep the local Doc view available without an interstitial, while refusing
  // to show it on systems where Electron cannot enable capture protection.
  privacyUnlocked = Boolean(overlayWindow.isContentProtected?.());

  overlayWindow.loadFile(path.join(__dirname, 'index.html'));
  overlayWindow.on('resize', () => {
    if ((documentView || chatView) && privacyUnlocked) {
      // Renderer reports the exact embedded-view viewport after its resize event.
      overlayWindow.webContents.send('document:layout-needed');
    }
  });
  // Keep the title-bar controls in sync with the *actual* window state, however
  // it changed — our buttons, a drag-bar double-click, or Windows Snap. Relying
  // on isMaximized() read right after maximize() is unreliable (it can be stale),
  // so the button icon is driven by these events instead of the click result.
  const sendWindowState = () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('window:state', {
        maximized: overlayWindow.isMaximized(),
        minimized: overlayWindow.isMinimized(),
      });
    }
  };
  // When the window comes back from the taskbar to a normal (non-maximized) state,
  // put it back on top — it is the whole point of an overlay.
  const reassertOnTop = () => {
    if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isMaximized()) {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  };
  // Manage always-on-top from the state events so it is correct however the state
  // changed (our buttons, a drag-bar double-click, or Windows Snap): off while
  // maximized so the user can reach other apps, back on top once windowed again.
  overlayWindow.on('maximize', () => { overlayWindow.setAlwaysOnTop(false); sendWindowState(); });
  overlayWindow.on('unmaximize', () => { reassertOnTop(); sendWindowState(); });
  overlayWindow.on('minimize', sendWindowState);
  overlayWindow.on('restore', () => { reassertOnTop(); sendWindowState(); });
  overlayWindow.on('show', reassertOnTop);
  overlayWindow.once('ready-to-show', () => { overlayWindow.show(); sendWindowState(); });
  overlayWindow.on('closed', () => {
    if (documentView) {
      documentView.webContents.close();
      documentView = null;
    }
    if (chatView) {
      chatView.webContents.close();
      chatView = null;
      chatReady = false;
    }
    overlayWindow = null;
  });
}

// Only one copy of the overlay may run at a time. A second launch just focuses
// the existing window (and restores it if minimized) instead of stacking another
// always-on-top window on top — which also caused userData cache-lock errors.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (overlayWindow.isMinimized()) overlayWindow.restore();
      overlayWindow.show();
      overlayWindow.focus();
    }
  });
}

// Collapse the overlay to / restore it from the slim always-on-top compact bar.
// Used by both the compact toggle and the minimize button (minimize = go to the bar,
// since with the taskbar hidden a real minimize would have no restore affordance).
function applyCompact(on) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  const next = Boolean(on);
  if (next === compactMode) return compactMode;
  compactMode = next;
  if (compactMode) {
    const [width, height] = overlayWindow.getSize();
    expandedBounds = { width: Math.max(1024, width), height: Math.max(640, height) };
    documentView?.setBounds(hiddenViewBounds);
    chatView?.setBounds(hiddenViewBounds);
    overlayWindow.setMinimumSize(760, 72);
    overlayWindow.setSize(Math.min(880, initialWorkArea.width), 72);
  } else {
    overlayWindow.setMinimumSize(1024, 640);
    overlayWindow.setSize(expandedBounds.width, expandedBounds.height);
  }
  // Keep the bar on top and visible so it is always reachable.
  try { overlayWindow.setAlwaysOnTop(true); } catch { /* ignore */ }
  overlayWindow.webContents.send('window:compact-changed', compactMode);
  return compactMode;
}

app.whenReady().then(() => {
  // The installer bundles the recognizer and capture helper as resources.
  const bundled = path.join(process.resourcesPath, 'captions');
  captionService = new CaptionService({
    projectRoot: path.join(__dirname, '..'),
    modelRoot: path.join(app.getPath('userData'), 'models'),
    runtime: app.isPackaged ? {
      workerCommand: [path.join(bundled, 'worker', 'caption-worker.exe')],
      capturePath: path.join(bundled, 'audio-capture.exe'),
      checkSample: path.join(bundled, 'speech-check.wav'),
    } : {},
    onEvent: payload => {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('captions:event', payload);
    },
  });
  ipcMain.handle('captions:configuration', () => captionService.configuration());
  ipcMain.handle('captions:start', (_event, options) => {
    if (!authAllowed) return { started: false, error: 'Access locked. Sign in and wait for admin approval.' };
    return captionService.start(options);
  });
  ipcMain.handle('captions:stop', () => captionService.stop());
  ipcMain.handle('models:download', (_event, id) => captionService.download(String(id)));
  ipcMain.handle('models:cancel', (_event, id) => captionService.cancel(String(id)));
  ipcMain.handle('privacy:capability', () => {
    const capability = privacyCapability();
    const protectedNow = Boolean(overlayWindow?.isContentProtected?.());
    return {
      ...capability,
      protectionEnabled: protectedNow,
      canUnlock: capability.supported && protectedNow,
    };
  });

  ipcMain.handle('privacy:unlock-after-remote-check', (_event, verified) => {
    if (!verified || !overlayWindow) return { unlocked: false };
    const capability = privacyCapability();
    const protectedNow = Boolean(overlayWindow.isContentProtected?.());
    if (!capability.supported || !protectedNow) return { unlocked: false };
    privacyUnlocked = true;
    return { unlocked: true };
  });

  ipcMain.handle('privacy:lock-content', () => {
    privacyUnlocked = false;
    documentView?.setBounds(hiddenViewBounds);
    chatView?.setBounds(hiddenViewBounds);
    return true;
  });

  ipcMain.handle('overlay:set-opacity', (_event, requested) => {
    if (!overlayWindow || typeof requested !== 'number' || !Number.isFinite(requested)) return false;
    overlayWindow.setOpacity(Math.min(1, Math.max(0.55, requested)));
    return true;
  });

  ipcMain.handle('window:toggle-compact', () => applyCompact(!compactMode));

  ipcMain.handle('window:control', (_event, action) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    if (action === 'minimize') {
      // The taskbar is hidden, so a real minimize would leave no way to restore the
      // window. Collapse to the always-on-top compact bar instead (like a dock) —
      // the user clicks Expand on the bar to bring the full window back.
      return applyCompact(true);
    }
    if (action === 'maximize') {
      // Treat fullscreen as "maximized" so the toggle always has a sane inverse.
      // The 'maximize'/'unmaximize' events handle the always-on-top switch.
      if (overlayWindow.isMaximized() || overlayWindow.isFullScreen()) {
        if (overlayWindow.isFullScreen()) overlayWindow.setFullScreen(false);
        overlayWindow.unmaximize();
      } else {
        overlayWindow.maximize();
      }
      return overlayWindow.isMaximized();
    }
    if (action === 'close') { overlayWindow.close(); return true; }
    return false;
  });

  // Manual window dragging from the top bar / compact bar / sign-in bar. The renderer
  // reports screen-space deltas; we move the window from where it was when the drag
  // began. (Native -webkit-app-region drag was unreliable in this overlay.)
  ipcMain.handle('window:drag-start', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return null;
    const [x, y] = overlayWindow.getPosition();
    windowDragOrigin = { x, y };
    return { x, y };
  });
  ipcMain.handle('window:drag-move', (_event, delta) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !windowDragOrigin || !delta) return false;
    if (overlayWindow.isMaximized() || overlayWindow.isFullScreen()) return false;
    const dx = Math.round(Number(delta.dx) || 0);
    const dy = Math.round(Number(delta.dy) || 0);
    overlayWindow.setPosition(windowDragOrigin.x + dx, windowDragOrigin.y + dy);
    return true;
  });
  ipcMain.handle('window:drag-end', () => { windowDragOrigin = null; return true; });

  ipcMain.handle('document:load-public', async (_event, rawUrl) => {
    if (!authAllowed) return { loaded: false, error: 'Access locked. Sign in and wait for admin approval.' };
    if (!privacyUnlocked || !overlayWindow?.isContentProtected?.()) {
      return { loaded: false, error: 'Unlock the protected local view first.' };
    }
    const url = normalizePublicDocsUrl(rawUrl);
    if (!url) {
      return { loaded: false, error: 'Enter a valid Google Docs document URL.' };
    }
    const view = createDocumentView();
    view.setBounds(hiddenViewBounds);
    activeDocumentUrl = url;
    try {
      await view.webContents.loadURL(url);
      const title = view.webContents.getTitle().replace(/\s+-\s+Google Docs\s*$/i, '').trim();
      overlayWindow.webContents.send('document:title', title || 'Google Doc');
      return { loaded: true, url, title: title || 'Google Doc' };
    } catch {
      view.setBounds(hiddenViewBounds);
      return { loaded: false, error: 'Google Docs could not be opened. Check the link and network connection.' };
    }
  });

  ipcMain.handle('document:set-bounds', (_event, bounds) => {
    setDocumentBounds(bounds);
    return true;
  });

  ipcMain.handle('document:reload', () => {
    if (!privacyUnlocked || !overlayWindow?.isContentProtected?.() || !documentView) return false;
    documentView.webContents.reload();
    return true;
  });

  ipcMain.handle('document:open-external', async () => {
    if (!activeDocumentUrl || !privacyUnlocked) return false;
    await shell.openExternal(activeDocumentUrl);
    return true;
  });

  // Creates the ChatGPT view on first use and loads it. Captions are fed into it
  // only after this succeeds.
  ipcMain.handle('chat:ensure', async () => {
    if (!authAllowed) return { loaded: false, error: 'Access locked. Sign in and wait for admin approval.' };
    if (!privacyUnlocked || !overlayWindow?.isContentProtected?.()) {
      return { loaded: false, error: 'Unlock the protected local view first.' };
    }
    const view = createChatView();
    view.setBounds(hiddenViewBounds);
    // Start loading but don't await it: ChatGPT redirects to sign-in/Cloudflare,
    // which can reject loadURL even on success. Readiness arrives via chat:state.
    if (!view.webContents.getURL()) {
      view.webContents.loadURL(CHAT_HOME_URL).catch(() => {});
    }
    const url = view.webContents.getURL();
    return { loaded: true, ready: chatReady, url, onChatGpt: isChatGptUrl(url) };
  });

  ipcMain.handle('chat:set-bounds', (_event, bounds) => {
    setChatBounds(bounds);
    return true;
  });

  ipcMain.handle('chat:reload', () => {
    if (!privacyUnlocked || !chatView) return false;
    chatView.webContents.reload();
    return true;
  });

  ipcMain.handle('chat:home', () => {
    if (!privacyUnlocked || !chatView) return false;
    chatView.webContents.loadURL(CHAT_HOME_URL).catch(() => {});
    return true;
  });

  ipcMain.handle('chat:open-external', async () => {
    const url = chatView?.webContents.getURL();
    if (!url || !privacyUnlocked) return false;
    await shell.openExternal(url);
    return true;
  });

  // Fill-only: sets ChatGPT's composer to the live transcript. Never submitted;
  // the user reviews and presses Send. The renderer only calls this while the
  // ChatGPT tab is the active view, so focusing the view does not hijack the
  // keyboard from the other tabs.
  ipcMain.handle('chat:set-composer', async (_event, payload) => {
    if (!authAllowed || !chatView || !privacyUnlocked) return { ok: false };
    const text = payload && typeof payload === 'object' ? String(payload.text ?? '') : String(payload ?? '');
    const prev = payload && typeof payload === 'object' && 'prev' in payload
      ? (payload.prev == null ? null : String(payload.prev)) : null;
    try {
      // userGesture=true lets execCommand('insertText') run without a keypress.
      chatView.webContents.focus();
      const res = await chatView.webContents.executeJavaScript(composerSetScript(text, prev), true);
      return res && typeof res === 'object' ? res : { ok: Boolean(res) };
    } catch {
      return { ok: false };
    }
  });

  // Capture button (ChatGPT tab): grab the whole screen and attach it to ChatGPT's
  // prompt. The overlay is capture-protected, so it is never in the shot — only the
  // code/windows behind it. Nothing is submitted; the user reviews and presses Send.
  //
  // The reliable path is a REAL Ctrl+V of the screenshot sitting on the OS clipboard —
  // exactly what a human does, which ChatGPT always honors. Synthetic paste / file-input
  // injections looked like they worked (the call ran) but never actually attached, so we
  // now VERIFY by watching the attachment count, and only fall back if nothing appeared.
  ipcMain.handle('code:capture-to-chat', async () => {
    if (!authAllowed || !privacyUnlocked) return { ok: false, error: 'Unlock the protected view first.' };
    if (!overlayWindow?.isContentProtected?.()) {
      return { ok: false, error: 'Screen-share protection is off — capture blocked.' };
    }
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      // Capture the display under the cursor at full pixel resolution.
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
      const sf = display.scaleFactor || 1;
      const thumbnailSize = {
        width: Math.max(1, Math.round(display.size.width * sf)),
        height: Math.max(1, Math.round(display.size.height * sf)),
      };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
      if (!sources.length) return { ok: false, error: 'No screen was available to capture.' };
      const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      const image = source.thumbnail;
      if (!image || image.isEmpty()) return { ok: false, error: 'The screen capture came back empty.' };

      const view = createChatView();
      if (!view.webContents.getURL()) view.webContents.loadURL(CHAT_HOME_URL).catch(() => {});
      const wc = view.webContents;
      const dataUrl = image.toDataURL();

      const composerReady = await wc.executeJavaScript(COMPOSER_FOCUS_SCRIPT, true).catch(() => false);
      if (!composerReady) {
        logCapture({ stage: 'focus', composer: false });
        return { ok: false, error: 'Open and sign in to ChatGPT first, then capture.' };
      }
      const count = async () => {
        try { return Number(await wc.executeJavaScript(ATTACHMENT_COUNT_EXPR, true)) || 0; }
        catch { return -1; }
      };
      const before = await count();
      let method = 'none';

      // Method A — real Ctrl+V with the screenshot on the clipboard (the human path).
      // Guarded on its own so a clipboard/keystroke hiccup falls through to B/C
      // instead of failing the whole capture.
      let aError = null;
      try {
        clipboard.writeImage(image);
        try { wc.focus(); } catch { /* ignore */ }
        await delay(130);
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
        await delay(1000);
        if ((await count()) > before) method = 'keystroke';
      } catch (e) { aError = (e && e.message) || String(e); }

      // Method B — ChatGPT's hidden file input.
      if (method === 'none') {
        await wc.executeJavaScript(fileInputInjectScript(dataUrl), true).catch(() => {});
        await delay(1100);
        if ((await count()) > before) method = 'input';
      }
      // Method C — synthetic paste / drop.
      if (method === 'none') {
        await wc.executeJavaScript(syntheticPasteInjectScript(dataUrl), true).catch(() => {});
        await delay(900);
        if ((await count()) > before) method = 'paste';
      }

      const after = await count();
      logCapture({ before, after, method, aError });
      if (method === 'none') {
        return { ok: false, error: 'The screenshot did not attach to ChatGPT. Make sure you are signed in and try again.' };
      }
      return { ok: true };
    } catch (err) {
      logCapture({ thrown: (err && err.message) || String(err) });
      return { ok: false, error: 'Screen capture failed: ' + ((err && err.message) || String(err)) };
    }
  });

  session.fromPartition('meeting-doc-view').setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  // ChatGPT needs clipboard; deny the rest (camera, mic, geolocation, notifications).
  session.fromPartition(CHAT_PARTITION).setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'));

  createOverlay();
  setupAuth();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
let quitting = false;
app.on('before-quit', event => {
  // A partial download resumes next time; a running speed check is stopped.
  for (const operation of captionService?.downloads.values() || []) operation.abort();
  if (!quitting && captionService?.worker) {
    event.preventDefault();
    quitting = true;
    captionService.stop().finally(() => app.quit());
  }
});
