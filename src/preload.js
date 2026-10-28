const { contextBridge, ipcRenderer } = require('electron');

const layoutListeners = new Set();
const titleListeners = new Set();
const compactListeners = new Set();
const captionListeners = new Set();
const chatStateListeners = new Set();
const authStateListeners = new Set();
const windowStateListeners = new Set();
ipcRenderer.on('document:layout-needed', () => {
  for (const listener of layoutListeners) listener();
});
ipcRenderer.on('document:title', (_event, title) => {
  for (const listener of titleListeners) listener(title);
});
ipcRenderer.on('window:compact-changed', (_event, compact) => {
  for (const listener of compactListeners) listener(compact);
});
ipcRenderer.on('window:state', (_event, state) => {
  for (const listener of windowStateListeners) listener(state);
});
ipcRenderer.on('captions:event', (_event, payload) => {
  for (const listener of captionListeners) listener(payload);
});
ipcRenderer.on('chat:state', (_event, state) => {
  for (const listener of chatStateListeners) listener(state);
});
ipcRenderer.on('auth:state', (_event, state) => {
  for (const listener of authStateListeners) listener(state);
});

contextBridge.exposeInMainWorld('privacy', {
  capability: () => ipcRenderer.invoke('privacy:capability'),
  unlockAfterRemoteCheck: (verified) =>
    ipcRenderer.invoke('privacy:unlock-after-remote-check', verified),
  lockContent: () => ipcRenderer.invoke('privacy:lock-content'),
  setOpacity: (opacity) => ipcRenderer.invoke('overlay:set-opacity', opacity),
  toggleCompact: () => ipcRenderer.invoke('window:toggle-compact'),
  captionConfiguration: () => ipcRenderer.invoke('captions:configuration'),
  startCaptions: (options) => ipcRenderer.invoke('captions:start', options),
  stopCaptions: () => ipcRenderer.invoke('captions:stop'),
  // Downloads, verifies, then speed-checks a model; progress arrives as captions events.
  downloadModel: (id) => ipcRenderer.invoke('models:download', id),
  cancelModelDownload: (id) => ipcRenderer.invoke('models:cancel', id),
  controlWindow: (action) => ipcRenderer.invoke('window:control', action),
  // Manual window dragging (native app-region drag is unreliable here).
  windowDragStart: () => ipcRenderer.invoke('window:drag-start'),
  windowDragMove: (delta) => ipcRenderer.invoke('window:drag-move', delta),
  windowDragEnd: () => ipcRenderer.invoke('window:drag-end'),
  loadPublicDocument: (url) => ipcRenderer.invoke('document:load-public', url),
  setDocumentBounds: (bounds) => ipcRenderer.invoke('document:set-bounds', bounds),
  reloadDocument: () => ipcRenderer.invoke('document:reload'),
  openDocumentExternal: () => ipcRenderer.invoke('document:open-external'),
  // ChatGPT browser view and live-caption injection.
  ensureChat: () => ipcRenderer.invoke('chat:ensure'),
  setChatBounds: (bounds) => ipcRenderer.invoke('chat:set-bounds', bounds),
  reloadChat: () => ipcRenderer.invoke('chat:reload'),
  newChat: () => ipcRenderer.invoke('chat:home'),
  openChatExternal: () => ipcRenderer.invoke('chat:open-external'),
  setChatComposer: (payload) => ipcRenderer.invoke('chat:set-composer', payload),
  // Full-screen screenshot pasted into the ChatGPT composer as an image attachment.
  captureScreenToChat: () => ipcRenderer.invoke('code:capture-to-chat'),
  onChatState: (listener) => {
    if (typeof listener === 'function') chatStateListeners.add(listener);
  },
  onDocumentLayoutNeeded: (listener) => {
    if (typeof listener === 'function') layoutListeners.add(listener);
  },
  onDocumentTitle: (listener) => {
    if (typeof listener === 'function') titleListeners.add(listener);
  },
  onCompactChanged: (listener) => {
    if (typeof listener === 'function') compactListeners.add(listener);
  },
  onWindowState: (listener) => {
    if (typeof listener === 'function') windowStateListeners.add(listener);
  },
  onCaptionsEvent: (listener) => {
    if (typeof listener === 'function') captionListeners.add(listener);
  },
});

contextBridge.exposeInMainWorld('auth', {
  getState: () => ipcRenderer.invoke('auth:get-state'),
  signInGoogle: (plan) => ipcRenderer.invoke('auth:signin-google', plan),
  signInDev: (email, name, plan) => ipcRenderer.invoke('auth:signin-dev', { email, name, plan }),
  signOut: () => ipcRenderer.invoke('auth:signout'),
  recheck: () => ipcRenderer.invoke('auth:recheck'),
  claimDevice: () => ipcRenderer.invoke('auth:claim-device'),
  subscribe: () => ipcRenderer.invoke('billing:subscribe'),
  onAuthState: (listener) => {
    if (typeof listener === 'function') authStateListeners.add(listener);
  },
});
