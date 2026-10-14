// Caption service lifecycle checks without the UI or audio playback:
//   node scripts/lifecycle-captions.cjs
// Covers missing and corrupt models, stopping while a model loads, an
// unavailable output, worker and capture crashes, and the parent being killed.
// After each case no worker or capture process may remain.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CaptionService } = require('../src/captions');
const { MODELS } = require('../src/models');

const root = path.join(__dirname, '..');
const models = process.env.CAPTION_MODELS || path.join(process.env.APPDATA, 'private-meeting-overlay', 'models');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function processTable() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
  { windowsHide: true, maxBuffer: 1 << 24 }).toString();
  return JSON.parse(out);
}

function descendants(pid, table = processTable()) {
  const found = [];
  for (const p of table) if (p.ParentProcessId === pid) found.push(p, ...descendants(p.ProcessId, table));
  return found;
}

// Windows reuses PIDs quickly (this test starts a PowerShell every poll), so a
// leftover must also still be a caption process.
function alive(pids) {
  const table = processTable();
  return table.filter(p => pids.includes(p.ProcessId) && /python|caption-worker|audio-capture/i.test(p.Name));
}

async function waitFor(label, check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(200); }
  throw new Error(`Timed out: ${label}`);
}

// CAPTION_WORKER tests a frozen worker (build/worker-dist/...) instead of the Python environment.
const runtime = process.env.CAPTION_WORKER ? { workerCommand: [process.env.CAPTION_WORKER] } : {};

function service(modelRoot = models) {
  const events = [];
  const svc = new CaptionService({ projectRoot: root, modelRoot, onEvent: e => events.push(e), runtime });
  return { svc, events };
}

// A model folder whose files have the catalog's exact sizes but hold only zeros, as
// after disk damage: it counts as installed, so the worker itself must fail cleanly.
function fakeModelRoot(id) {
  const model = MODELS.find(m => m.id === id);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-models-'));
  fs.mkdirSync(path.join(dir, model.folder));
  for (const file of model.files) {
    const target = path.join(dir, model.folder, file.path);
    fs.writeFileSync(target, '');
    fs.truncateSync(target, file.size);  // zero-filled, expected size
  }
  return dir;
}

// In development the service spawns the venv's python.exe, a launcher whose child is
// the real interpreter; a frozen worker is one process. The worker starts the capture helper.
async function family(svc, withCapture = true) {
  const launcher = svc.worker.child.pid;
  const frozen = Boolean(runtime.workerCommand);
  let tree = [];
  const ready = () => ((tree = descendants(launcher)), frozen || tree.some(p => /python/i.test(p.Name))) &&
    (!withCapture || tree.some(p => /audio-capture/i.test(p.Name)));
  await waitFor(withCapture ? 'capture helper started' : 'interpreter started', ready, 60000);
  return {
    launcher,
    worker: frozen ? launcher : tree.find(p => /python/i.test(p.Name) && p.ParentProcessId === launcher).ProcessId,
    capture: tree.find(p => /audio-capture/i.test(p.Name))?.ProcessId,
    all: [launcher, ...tree.map(p => p.ProcessId)],
  };
}

async function assertGone(pids, label) {
  await waitFor(`${label}: processes exit`, () => alive(pids).length === 0, 20000);
}

const cases = {
  async 'missing model refuses to start with setup guidance'() {
    const { svc } = service(fs.mkdtempSync(path.join(os.tmpdir(), 'caption-models-')));
    const config = await svc.configuration();
    assert(config.models.every(p => !p.installed));
    const result = svc.start({ profile: 'parakeet' });
    assert.equal(result.started, false);
    assert.match(result.error, /Download this speech model/);
  },

  async 'a truncated model counts as not installed and is offered again'() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-models-'));
    fs.mkdirSync(path.join(dir, 'parakeet-en'));
    fs.writeFileSync(path.join(dir, 'parakeet-en', 'encoder.int8.onnx'), 'cut short');
    const { svc } = service(dir);
    assert.equal((await svc.configuration()).models.find(m => m.id === 'parakeet').installed, false);
    assert.match(svc.start({ profile: 'parakeet' }).error, /Download this speech model/);
  },

  async 'corrupt Parakeet model reports a readable error'() {
    const { svc, events } = service(fakeModelRoot('parakeet'));
    assert(svc.start({ profile: 'parakeet' }).started);
    // The native loader exits within moments, so record every process seen until then.
    const seen = new Set([svc.worker.child.pid]);
    await waitFor('stopped', () => {
      for (const p of descendants(svc.worker?.child.pid ?? -1)) seen.add(p.ProcessId);
      return events.some(e => e.type === 'stopped');
    }, 60000);
    const errors = events.filter(e => e.type === 'error');
    assert(errors.length >= 1, JSON.stringify(events));
    assert(errors.every(e => e.message.length < 400 && !/Traceback/.test(e.message)), JSON.stringify(errors));
    await assertGone([...seen], 'corrupt Parakeet');
    return errors.map(e => e.message);
  },

  async 'corrupt Whisper model reports a readable error'() {
    const { svc, events } = service(fakeModelRoot('whisper-small'));
    assert(svc.start({ profile: 'whisper-small' }).started);
    await waitFor('stopped', () => events.some(e => e.type === 'stopped'), 60000);
    const errors = events.filter(e => e.type === 'error');
    assert(errors.length >= 1, JSON.stringify(events));
    assert(errors.every(e => e.message.length < 400 && !/Traceback/.test(e.message)), JSON.stringify(errors));
    return errors.map(e => e.message);
  },

  async 'stop while the model loads'() {
    const { svc, events } = service();
    assert(svc.start({ profile: 'parakeet' }).started);
    const { all } = await family(svc, false);
    assert(!events.some(e => e.type === 'status' && e.state === 'running'), 'must still be loading');
    const started = Date.now();
    await svc.stop();
    const seconds = (Date.now() - started) / 1000;
    assert(!events.some(e => e.type === 'error'), JSON.stringify(events));
    assert.equal(events.filter(e => e.type === 'stopped').length, 1);
    await assertGone(all, 'stop while loading');
    return `stopped in ${seconds.toFixed(1)} s`;
  },

  async 'unavailable output waits instead of failing'() {
    const { svc, events } = service();
    assert(svc.start({ profile: 'parakeet', device: '{0.0.0.00000000}.{00000000-0000-0000-0000-000000000000}' }).started);
    const { all } = await family(svc);
    await waitFor('waiting status', () => events.some(e => e.type === 'status' && e.state === 'waiting'), 60000);
    await delay(4000);
    const notices = events.filter(e => e.type === 'notice' && e.message);
    assert(notices.length >= 1 && notices.length <= 2, `rate-limited notices, got ${notices.length}`);
    assert.match(notices[0].message, /unavailable/i);
    assert(!events.some(e => e.type === 'error'), JSON.stringify(events));
    await svc.stop();
    await assertGone(all, 'unavailable output');
    return notices[0].message;
  },

  async 'worker crash is reported and capture exits'() {
    const { svc, events } = service();
    assert(svc.start({ profile: 'parakeet' }).started);
    await waitFor('running', () => events.some(e => e.type === 'status' && e.state === 'running'), 60000);
    const { worker, all } = await family(svc);
    execFileSync('taskkill.exe', ['/PID', String(worker), '/F'], { windowsHide: true }); // the interpreter itself
    await waitFor('stopped', () => events.some(e => e.type === 'stopped'));
    assert(events.some(e => e.type === 'error' && /unexpectedly/.test(e.message)), JSON.stringify(events.slice(-4)));
    await assertGone(all, 'worker crash');
  },

  async 'capture crash is reported and the worker exits'() {
    const { svc, events } = service();
    assert(svc.start({ profile: 'parakeet' }).started);
    await waitFor('running', () => events.some(e => e.type === 'status' && e.state === 'running'), 60000);
    const { capture, all } = await family(svc);
    execFileSync('taskkill.exe', ['/PID', String(capture), '/F'], { windowsHide: true });
    await waitFor('stopped', () => events.some(e => e.type === 'stopped'));
    const errors = events.filter(e => e.type === 'error');
    assert(errors.some(e => /capture stopped/i.test(e.message)), JSON.stringify(errors));
    await assertGone(all, 'capture crash');
    return errors.map(e => e.message);
  },

  async 'parent killed: worker and capture exit on their own'() {
    const script = `const { CaptionService } = require(${JSON.stringify(path.join(root, 'src', 'captions.js'))});
      const svc = new CaptionService({ projectRoot: ${JSON.stringify(root)}, modelRoot: ${JSON.stringify(models)}, runtime: ${JSON.stringify(runtime)}, onEvent: e => {
        if (e.type === 'status' && e.state === 'running') console.log('PID ' + svc.worker.child.pid);
      } });
      svc.start({ profile: 'parakeet' }); setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['-e', script], { windowsHide: true });
    let worker;
    parent.stdout.on('data', chunk => { const m = /PID (\d+)/.exec(chunk.toString()); if (m) worker = Number(m[1]); });
    await waitFor('child service running', () => worker, 60000);
    let tree = [];
    await waitFor('capture helper running', () => (tree = descendants(worker)).some(p => /audio-capture/i.test(p.Name)));
    execFileSync('taskkill.exe', ['/PID', String(parent.pid), '/F'], { windowsHide: true });
    await assertGone([worker, ...tree.map(p => p.ProcessId)], 'parent killed');
  },

  async 'service restarts normally afterwards'() {
    const { svc, events } = service();
    assert(svc.start({ profile: 'parakeet' }).started);
    await waitFor('running', () => events.some(e => e.type === 'status' && e.state === 'running'), 60000);
    const { all } = await family(svc);
    await svc.stop();
    assert(!events.some(e => e.type === 'error'), JSON.stringify(events));
    await assertGone(all, 'normal stop');
  },
};

(async () => {
  const results = [];
  for (const [name, run] of Object.entries(cases)) {
    const started = Date.now();
    try {
      const detail = await run();
      results.push({ name, passed: true, seconds: (Date.now() - started) / 1000, detail });
      console.log(`PASS ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
    } catch (error) {
      results.push({ name, passed: false, error: String(error.stack || error) });
      console.log(`FAIL ${name}\n  ${String(error.message || error).slice(0, 600)}`);
    }
  }
  const out = path.join(root, 'artifacts', 'captions', 'lifecycle.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2));
  process.exitCode = results.every(r => r.passed) ? 0 : 1;
})();
