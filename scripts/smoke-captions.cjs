// Run with Electron and a public WAV: node node_modules/electron/cli.js scripts/smoke-captions.cjs sample.wav
// Plays the sample through the default speakers to exercise real WASAPI loopback.
// Any renderer console error, preload error, or renderer crash fails the run.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const root = path.join(__dirname, '..');
const artifacts = path.join(root, 'artifacts', 'captions');
const profile = path.join(artifacts, 'ui-profile');
fs.mkdirSync(profile, { recursive: true });
const models = path.join(profile, 'models');
if (!fs.existsSync(models)) fs.symlinkSync(path.join(app.getPath('appData'), 'private-meeting-overlay', 'models'), models, 'junction');
app.setPath('userData', profile);
const wav = path.resolve(process.argv[2] || path.join(artifacts, 'jfk.wav'));
assert(fs.existsSync(wav), 'A public test WAV is required');
const resultPath = path.join(artifacts, 'ui-smoke.json');
// A stale passing result must never be mistaken for this run.
fs.rmSync(resultPath, { force: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rendererErrors = [];
const STUB_DOC = 'https://docs.google.com/document/d/smoke-test-doc/edit';
let failed = false;
// The app's before-quit handler stops the caption worker first; then report failure.
app.on('will-quit', () => { if (failed) app.exit(1); });

// Serve a stub Doc inside the embedded view's own session so the Docs layout
// checks run offline and never contact Google.
app.whenReady().then(() => {
  session.fromPartition('meeting-doc-view').protocol.handle('https', () => new Response(
    '<!doctype html><title>Smoke test doc - Google Docs</title><p>Stub document</p>',
    { headers: { 'content-type': 'text/html' } }));
});

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', (details, legacyLevel, legacyMessage) => {
    const level = details.level ?? legacyLevel; // Electron 35+ puts these on the event
    if (level === 'error' || level === 3) rendererErrors.push(details.message ?? legacyMessage);
  });
  win.webContents.on('preload-error', (_e, _preload, error) => rendererErrors.push(`preload: ${error.message}`));
  win.webContents.on('render-process-gone', (_e, details) => rendererErrors.push(`renderer gone: ${details.reason}`));
});

function writeResult(result) {
  fs.writeFileSync(resultPath, JSON.stringify({ finishedAt: new Date().toISOString(), ...result }, null, 2));
}

async function run(win) {
  const js = code => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await js(code)) return; await delay(200); }
    throw new Error(`Timed out: ${code}`);
  };
  const waitFor = async (label, check, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (check()) return; await delay(100); }
    throw new Error(`Timed out: ${label}`);
  };
  const noRendererErrors = stage => assert.deepEqual(rendererErrors, [], `Renderer errors ${stage}`);
  const docView = () => win.contentView.children.find(v => v.webContents && v.webContents.id !== win.webContents.id);
  const docVisible = () => { const b = docView()?.getBounds(); return Boolean(b && b.width > 0 && b.height > 0); };
  const header = () => js(`({ title: document.getElementById('content-title').textContent,
    subtitle: document.getElementById('content-subtitle').textContent,
    formHidden: getComputedStyle(document.getElementById('document-form')).display === 'none' })`);
  const checks = [];
  try {
    await until("!document.getElementById('start-captions').disabled");
    assert(win.isContentProtected(), 'OS content protection request must be enabled');
    assert(win.isAlwaysOnTop(), 'Overlay must remain on top');
    noRendererErrors('at startup');

    // Embedded Docs view: shown only on the Doc tab in the expanded window.
    await js(`document.getElementById('document-url').value = ${JSON.stringify(STUB_DOC)};
      document.getElementById('document-form').requestSubmit();`);
    await until("document.getElementById('content-title').textContent === 'Smoke test doc'");
    await waitFor('Docs view shown on its tab', docVisible);
    assert.equal((await header()).formHidden, false, 'Doc toolbar must show on the Doc tab');
    await js("document.querySelector('[data-view=\"captions\"]').click()");
    await waitFor('Docs view hidden on Captions', () => !docVisible());
    let h = await header();
    assert.equal(h.formHidden, true, 'Doc toolbar must be hidden on Captions');
    assert.equal(h.title, 'Captions');
    assert.equal(h.subtitle, 'Live captions · Audio off');
    await js("document.querySelector('[data-view=\"ai\"]').click()");
    assert.equal((await header()).formHidden, true, 'Doc toolbar must be hidden on Ask AI');
    assert(!docVisible(), 'Docs view must be hidden on Ask AI');
    await js("document.querySelector('[data-view=\"document\"]').click()");
    await waitFor('Docs view restored on its tab', docVisible);
    await js("document.getElementById('minimize-button').click()");
    await until("document.body.classList.contains('compact')");
    await waitFor('Docs view hidden in compact mode', () => !docVisible());
    await js("document.getElementById('minimize-button').click()");
    await until("!document.body.classList.contains('compact')");
    await waitFor('Docs view restored after compact mode', docVisible);
    noRendererErrors('after tab and compact changes');
    checks.push('Doc toolbar and embedded Docs view hide off the Doc tab and in compact mode');

    // Transcript behavior, driven by synthetic events on the worker's IPC channel.
    const send = event => win.webContents.send('captions:event', event);
    const line = i => ({ type: 'final', id: `ui:${i}`, text: `Synthetic caption line ${i}.` });
    await js("document.querySelector('[data-view=\"captions\"]').click()");
    for (let i = 1; i <= 130; i++) send(line(i));
    await until(`document.querySelectorAll('#caption-transcript .caption-line').length === 100 &&
      document.querySelector('#caption-transcript .caption-line').textContent === 'Synthetic caption line 31.'`);
    const view = `(() => { const t = document.getElementById('caption-transcript'); const r = t.getBoundingClientRect();
      const first = [...t.children].find(p => p.getBoundingClientRect().bottom > r.top + 21);
      return { top: first?.textContent, offset: first && Math.round(first.getBoundingClientRect().top - r.top),
        atBottom: t.scrollHeight - t.scrollTop - t.clientHeight < 80 }; })()`;
    const reading = await js(`(() => { const t = document.getElementById('caption-transcript');
      t.scrollTop = t.scrollHeight / 2; return ${view}; })()`);
    for (let i = 131; i <= 135; i++) send(line(i));
    await until("document.querySelector('#caption-transcript .caption-line:last-child').textContent === 'Synthetic caption line 135.'");
    const held = await js(view);
    assert.equal(held.top, reading.top, 'A reader scrolled up keeps their place while lines arrive and old ones go');
    assert(Math.abs(held.offset - reading.offset) <= 2, `Reading position moved ${held.offset - reading.offset}px`);
    assert(!held.atBottom);
    await js("document.getElementById('caption-transcript').scrollTop = 1e9");
    send(line(136));
    await until("document.querySelector('#caption-transcript .caption-line:last-child').textContent === 'Synthetic caption line 136.'");
    assert((await js(view)).atBottom, 'A reader at the bottom follows new lines');
    send({ type: 'partial', id: 'ui:p', text: 'Interim words' });
    await until("document.querySelector('#caption-transcript .caption-line:last-child').classList.contains('partial')");
    send({ type: 'final', id: 'ui:p', text: 'Final words.' });
    send({ type: 'partial', id: 'ui:q', text: 'maybe' });
    send({ type: 'final', id: 'ui:q', text: '' });
    await until(`[...document.querySelectorAll('#caption-transcript .caption-line')].slice(-1).map(p =>
      p.textContent === 'Final words.' && !p.classList.contains('partial'))[0]`);
    // The rejected interim is gone (its arrival had already evicted the oldest line).
    assert.equal(await js("document.querySelector('#caption-transcript [data-caption-id=\"ui:q\"]')"), null);
    assert(await js("document.querySelectorAll('#caption-transcript .caption-line').length") <= 100);
    send({ type: 'partial', id: 'ui:r', text: 'Words still arriving' });
    await js("document.getElementById('clear-captions').click()");
    assert.equal(await js("document.getElementById('caption-transcript').children.length"), 0, 'Clear empties the transcript');
    send({ type: 'final', id: 'ui:r', text: 'Words still arriving, finished.' });
    await until("document.getElementById('caption-transcript').innerText.includes('finished')");
    await js("document.getElementById('clear-captions').click()");
    // A revision updates a shown line; one for a cleared line must not bring it back.
    send({ type: 'final', id: 'ui:v', text: 'Before revision.' });
    send({ type: 'final', id: 'ui:v', text: 'After revision,', revision: true });
    await until("document.getElementById('caption-transcript').innerText.trim() === 'After revision,'");
    await js("document.getElementById('clear-captions').click()");
    send({ type: 'final', id: 'ui:v', text: 'Revised after clearing.', revision: true });
    send({ type: 'final', id: 'ui:w', text: 'Next phrase.' });
    await until("document.getElementById('caption-transcript').innerText.includes('Next phrase.')");
    assert.equal(await js("document.getElementById('caption-transcript').innerText.trim()"), 'Next phrase.');
    await js("document.getElementById('clear-captions').click()");
    checks.push('transcript: 100-line cap, reading position held, follow at bottom, interim/final/empty, clear mid-phrase, revisions');

    // Caption settings at the minimum window size must stay reachable.
    const [width, height] = win.getSize();
    win.setSize(1024, 640);
    await js(`window.__captionEvents = []; window.privacy.onCaptionsEvent(e => window.__captionEvents.push(e));
      document.querySelector('[data-view="captions"]').click();
      document.querySelector('input[value="parakeet"]').click();
      document.getElementById('caption-settings').open = true;`);
    await delay(400);
    // Reachable means on screen, or inside a container the user can scroll
    // (overflow auto/scroll). overflow:hidden ancestors do not count.
    const layout = await js(`(() => {
      const onScreen = el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; };
      const startVisible = onScreen(document.getElementById('start-captions'));
      const last = document.getElementById('caption-options').lastElementChild;
      let lastVisible = onScreen(last), scrolled = null;
      for (let el = last.parentElement; !lastVisible && el; el = el.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight && onScreen(el)) {
          el.scrollTop = el.scrollHeight;
          lastVisible = onScreen(last);
          scrolled = el;
        }
      }
      return { lastVisible, startVisible, scrolledId: scrolled?.id || null };
    })()`);
    fs.writeFileSync(path.join(artifacts, 'settings-min.png'), (await win.webContents.capturePage()).toPNG());
    if (layout.scrolledId) await js(`document.getElementById(${JSON.stringify(layout.scrolledId)}).scrollTop = 0`);
    assert(layout.lastVisible, 'Every caption setting must be reachable at the minimum window size');
    assert(layout.startVisible, 'Start captions must stay visible at the minimum window size');
    win.setSize(width, height);
    await delay(400);
    fs.writeFileSync(path.join(artifacts, 'settings.png'), (await win.webContents.capturePage()).toPNG());
    checks.push('caption settings reachable at the minimum window size');

    await js("document.getElementById('start-captions').click()");
    await until("window.__captionEvents.some(e => e.type === 'status' && e.state === 'running')", 60000);
    assert(await js("document.getElementById('caption-options').disabled"));
    h = await header();
    assert.equal(h.subtitle, 'Live captions · Listening · English · Offline', 'Header must follow caption status');
    const duplicate = await js("window.privacy.startCaptions({profile:'parakeet'})");
    assert.equal(duplicate.started, false, 'Concurrent workers must be rejected');
    const script = "$player = New-Object System.Media.SoundPlayer; $player.SoundLocation = $env:CAPTION_TEST_WAV; $player.PlaySync()";
    const playing = exec('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true, env: { ...process.env, CAPTION_TEST_WAV: wav }, timeout: 45000,
    });
    await delay(3000);
    await js("document.querySelector('[data-view=\"document\"]').click()");
    await waitFor('Docs view shown while captions run', docVisible);
    await delay(1500);
    await js("document.getElementById('minimize-button').click()");
    await delay(1500);
    assert(await js("document.body.classList.contains('compact')"));
    assert(!docVisible(), 'Docs view must be hidden in compact mode while captions run');
    await js("document.getElementById('minimize-button').click(); document.querySelector('[data-view=\"captions\"]').click()");
    await playing;
    await until("window.__captionEvents.some(e => e.type === 'final' && /country/i.test(e.text))");
    assert(!docVisible(), 'Docs view must stay hidden on Captions');
    assert.equal((await header()).subtitle, 'Live captions · Listening · English · Offline');
    await delay(1000);
    await js("document.getElementById('start-captions').click()");
    await until("window.__captionEvents.some(e => e.type === 'stopped')");
    await until("document.getElementById('content-subtitle').textContent === 'Live captions · Audio off'");
    const events = await js('window.__captionEvents');
    assert(events.some(e => e.type === 'partial'), 'Interim captions must appear');
    assert(!events.some(e => e.type === 'error'), JSON.stringify(events.filter(e => e.type === 'error')));
    assert.equal(events.filter(e => e.type === 'stopped').length, 1);
    const finals = events.filter(e => e.type === 'final' && e.text);
    // A phrase may be revised once, just before the first final of the phrase that gave it context.
    const perId = finals.reduce((counts, e) => counts.set(e.id, (counts.get(e.id) || 0) + 1), new Map());
    assert([...perId.values()].every(n => n <= 2), 'A phrase is finalized at most twice');
    const order = events.filter(e => e.type === 'final');
    const firstOf = id => order.findIndex(e => e.id === id);
    order.forEach((e, i) => {
      if (firstOf(e.id) !== i) assert(order[i + 1] && firstOf(order[i + 1].id) === i + 1, 'A revision precedes a new phrase');
    });
    assert(await js("!document.getElementById('caption-options').disabled"));
    const text = await js("document.getElementById('caption-transcript').innerText");
    assert.match(text, /fellow Americans/i);
    assert.match(text, /country/i);
    fs.writeFileSync(path.join(artifacts, 'captions.png'), (await win.webContents.capturePage()).toPNG());
    checks.push('real WASAPI loopback', 'partial and final captions', 'header follows caption status',
      'tab switching and compact mode during captions', 'duplicate start rejection');
    // Starting then immediately stopping must release the worker for another session.
    const next = await js("window.privacy.startCaptions({profile:'parakeet'})");
    assert(next.started);
    await js('window.privacy.stopCaptions()');
    checks.push('stop and immediate restart');
    await js("localStorage.removeItem('publicDocUrl')");
    noRendererErrors('during the run');
    checks.push('no renderer errors', 'OS protection setting (not remote-view verification)');
    writeResult({ passed: true, checks, text, events, rendererErrors });
    console.log(JSON.stringify({ passed: true, checks, finalPhrases: finals.length }));
    app.quit();
  } catch (error) {
    console.error(error);
    writeResult({ passed: false, error: String(error?.stack || error), checks, rendererErrors });
    failed = true;
    await js("localStorage.removeItem('publicDocUrl')").catch(() => {});
    for (const window of BrowserWindow.getAllWindows()) window.close();
    setTimeout(() => app.exit(1), 20000).unref();
  }
}
app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => void run(win)));
require('../src/main');
