const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, screen } = require('electron');
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
function composerSetScript(fullText) {
  const payload = JSON.stringify(String(fullText));
  return `(() => {
    const text = ${payload};
    const editor = document.querySelector('#prompt-textarea[contenteditable="true"]')
      || document.querySelector('div.ProseMirror[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"]');
    if (editor) {
      const current = editor.textContent || '';
      if (current === text) return true;
      let i = 0;
      const max = Math.min(current.length, text.length);
      while (i < max && current.charCodeAt(i) === text.charCodeAt(i)) i++;
      editor.focus();
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
      const a = locate(editor, i);
      const b = locate(editor, current.length);
      const sel = window.getSelection();
      const range = document.createRange();
      try { range.setStart(a.node, a.off); range.setEnd(b.node, b.off); }
      catch (e) { range.selectNodeContents(editor); }
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text.slice(i));
      return true;
    }
    const area = document.querySelector('textarea#prompt-textarea')
      || document.querySelector('main textarea')
      || document.querySelector('textarea');
    if (area) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), 'value');
      if (descriptor && descriptor.set) descriptor.set.call(area, text); else area.value = text;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  })()`;
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
    // Keep the embedded view's pointer stable as well as the native app shell.
    documentView?.webContents.insertCSS('*, *::before, *::after { cursor: pointer !important; }').catch(() => {});
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

// Where the gating backend lives: env override, then a userData/backend.json
// file the user can edit after deploy, then the local dev default.
function resolveBackendUrl() {
  if (process.env.MEETING_BACKEND_URL) return process.env.MEETING_BACKEND_URL;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'backend.json'), 'utf8'));
    if (cfg && typeof cfg.backendUrl === 'string' && cfg.backendUrl) return cfg.backendUrl;
  } catch { /* no file → default */ }
  return 'http://localhost:8787';
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
function enforceAuth(state) {
  authState = state;
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

function setupAuth() {
  authClient = createAuthClient({
    backendUrl: resolveBackendUrl(),
    storage: createTokenStorage(),
    heartbeatMs: 120000,
    offlineGraceMs: 600000,
    onState: enforceAuth,
    runGoogleAuth: ({ clientId }) => runLoopbackAuth({ clientId, openBrowser: (url) => shell.openExternal(url) }),
  });

  ipcMain.handle('auth:get-state', () => (authClient ? authClient.getState() : authState));
  ipcMain.handle('auth:signin-google', () => authClient.signInGoogle());
  ipcMain.handle('auth:signin-dev', (_event, payload) =>
    authClient.signInStub(String((payload && payload.email) || ''), String((payload && payload.name) || '')));
  ipcMain.handle('auth:signout', () => authClient.signOut());
  ipcMain.handle('auth:recheck', () => authClient.recheck());

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
    title: 'Private Meeting Assistant',
    alwaysOnTop: true,
    opacity: 0.94,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
  overlayWindow.once('ready-to-show', () => overlayWindow.show());
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

  ipcMain.handle('window:toggle-compact', () => {
    if (!overlayWindow) return false;
    compactMode = !compactMode;
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
    overlayWindow.webContents.send('window:compact-changed', compactMode);
    return compactMode;
  });

  ipcMain.handle('window:control', (_event, action) => {
    if (!overlayWindow) return false;
    if (action === 'minimize') overlayWindow.minimize();
    else if (action === 'maximize') overlayWindow.isMaximized() ? overlayWindow.unmaximize() : overlayWindow.maximize();
    else if (action === 'close') overlayWindow.close();
    else return false;
    return true;
  });

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
  ipcMain.handle('chat:set-composer', async (_event, text) => {
    if (!authAllowed || !chatView || !privacyUnlocked) return { ok: false };
    try {
      // userGesture=true lets execCommand('insertText') run without a keypress.
      chatView.webContents.focus();
      const ok = await chatView.webContents.executeJavaScript(composerSetScript(String(text ?? '')), true);
      return { ok: Boolean(ok) };
    } catch {
      return { ok: false };
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
