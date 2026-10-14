const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const models = require('./models');
const execFileAsync = promisify(execFile);

const WORKER_ENV = { PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
const THREADS = '3';  // as fast as 6 on the test laptop, with about 60% less CPU

class CaptionService {
  // An installed app passes its bundled recognizer and capture helper in `runtime`;
  // development uses the project's Python environment and build output.
  constructor({ projectRoot, modelRoot, onEvent, runtime = {} }) {
    this.modelRoot = modelRoot;
    this.onEvent = onEvent;
    this.worker = null;
    this.session = 0;
    this.downloads = new Map();  // model id -> AbortController, for a download or speed check
    this.capturePath = runtime.capturePath || path.join(projectRoot, 'native', 'captions', 'target', 'release', 'audio-capture.exe');
    this.workerCommand = runtime.workerCommand || [path.join(projectRoot, '.venv-captions', 'Scripts', 'python.exe'), '-u',
      path.join(projectRoot, 'native', 'captions-local', 'worker.py')];
    this.checkSample = runtime.checkSample || path.join(projectRoot, 'resources', 'speech-check.wav');
  }

  runtimeMissing() {
    return !fs.existsSync(this.workerCommand[0]) || !fs.existsSync(this.capturePath);
  }

  readCheck(model) {
    try { return JSON.parse(fs.readFileSync(path.join(this.modelRoot, model.folder, 'check.json'), 'utf8')); } catch { return null; }
  }

  async configuration() {
    let devices = [];
    let deviceError = '';
    if (fs.existsSync(this.capturePath)) {
      try {
        const { stdout } = await execFileAsync(this.capturePath, ['--list-devices'], { windowsHide: true, timeout: 5000, maxBuffer: 65536 });
        devices = JSON.parse(stdout);
      } catch { deviceError = 'Playback devices could not be listed. System default is still available.'; }
    }
    const pc = models.machine();
    const recommended = models.recommend(pc);
    return {
      models: models.MODELS.map(m => {
        const fit = models.assess(m, pc);
        return {
          id: m.id, name: m.name, label: m.label, summary: m.summary, downloadBytes: models.downloadBytes(m),
          installed: models.isInstalled(m, this.modelRoot), fit: fit.fit, fitNote: fit.note,
          checkNote: models.describeCheck(this.readCheck(m)), recommended: m.id === recommended,
          busy: this.downloads.has(m.id),
        };
      }),
      devices, deviceError, active: Boolean(this.worker), runtimeMissing: this.runtimeMissing(),
    };
  }

  // Download, verify, then time recognition on this PC. One model operation at a time,
  // and never while captions run, so the speed check measures an otherwise idle worker.
  async download(id) {
    const model = models.MODELS.find(m => m.id === id);
    if (!model) return { ok: false, error: 'Unknown speech model.' };
    if (this.worker) return { ok: false, error: 'Stop captions before downloading a model.' };
    if (this.downloads.size) return { ok: false, error: 'Another model is still downloading.' };
    const controller = new AbortController();
    this.downloads.set(id, controller);
    const send = (phase, extra = {}) => this.onEvent({ type: 'model', id, phase, ...extra });
    try {
      if (!models.isInstalled(model, this.modelRoot)) {
        await models.download(model, this.modelRoot, {
          signal: controller.signal, onProgress: p => send(p.phase, { done: p.done, total: p.total }),
        });
      }
      send('checking');
      const check = await this.check(model, controller.signal);
      send('ready', { checkNote: models.describeCheck(check) });
      return { ok: true };
    } catch (error) {
      send('error', { message: error.message });
      return { ok: false, error: error.message };
    } finally {
      this.downloads.delete(id);
    }
  }

  cancel(id) {
    this.downloads.get(id)?.abort();
    return true;
  }

  check(model, signal) {
    return new Promise(resolve => {
      const args = [...this.workerCommand.slice(1), '--engine', model.engine, '--model', path.join(this.modelRoot, model.folder),
        '--threads', THREADS, '--check', this.checkSample];
      const child = spawn(this.workerCommand[0], args, { windowsHide: true, env: { ...process.env, ...WORKER_ENV }, signal });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('error', () => resolve(null));
      child.on('close', () => {
        const result = output.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } })
          .find(event => event?.type === 'check');
        if (result) {
          fs.writeFileSync(path.join(this.modelRoot, model.folder, 'check.json'),
            JSON.stringify({ ...result, threads: Number(THREADS), checked: new Date().toISOString() }, null, 2));
        }
        resolve(result || null);
      });
    });
  }

  start(options = {}) {
    if (process.platform !== 'win32') return { started: false, error: 'System audio capture is available on Windows.' };
    if (this.worker) return { started: false, error: 'Wait for the current caption session to stop.' };
    if (this.downloads.size) return { started: false, error: 'Wait for the speech model download to finish.' };
    const profile = models.MODELS.find(p => p.id === (options?.profile || 'parakeet'));
    if (!profile) return { started: false, error: 'Choose a supported local speech engine.' };
    if (this.runtimeMissing()) return { started: false, error: 'Caption components are missing. Reinstall the app.' };
    if (!models.isInstalled(profile, this.modelRoot)) {
      return { started: false, error: 'Download this speech model in Caption settings first.' };
    }
    const device = typeof options?.device === 'string' && options.device.length <= 2048 ? options.device : '';
    const args = [...this.workerCommand.slice(1), '--model', path.join(this.modelRoot, profile.folder),
      '--engine', profile.engine, '--capture', this.capturePath, '--threads', THREADS];
    if (device) args.push('--device', device);
    const child = spawn(this.workerCommand[0], args, {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...WORKER_ENV },
    });
    const state = { child, stopping: false, error: false, session: ++this.session };
    this.worker = state;
    let buffer = '';
    const startupTimer = setTimeout(() => {
      if (this.worker !== state || state.stopping) return;
      state.error = true;
      this.onEvent({ type: 'error', message: 'The local engine did not start in time. Try another engine.' });
      void this.stop();
    }, 120000);
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.worker !== state) return;
      buffer += chunk;
      if (buffer.length > 262144) {
        state.error = true;
        this.onEvent({ type: 'error', message: 'The caption worker returned invalid output.' });
        void this.stop();
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        // The timer covers model loading; an unavailable output is reported separately.
        if (event.type === 'status' && ['running', 'waiting'].includes(event.state)) {
          state.loaded = true;
          clearTimeout(startupTimer);
        }
        if (event.type === 'error') state.error = true;
        if (event.type === 'stopped') continue; // Emit once after process cleanup.
        if (event.id !== undefined) event.id = `${state.session}:${event.id}`;
        if (!state.stopping || ['final', 'error'].includes(event.type)) this.onEvent(event);
      }
    });
    // Native diagnostic messages contain no captured audio or transcript text.
    child.stderr.on('data', chunk => console.error('[local-captions]', chunk.toString().trim()));
    child.on('error', error => {
      state.error = true;
      this.onEvent({ type: 'error', message: `Could not start local captions: ${error.message}` });
    });
    state.finished = new Promise(resolve => child.once('close', code => {
      clearTimeout(startupTimer);
      clearTimeout(state.stopTimer);
      if (this.worker === state) {
        this.worker = null;
        if (code !== 0 && !state.stopping && !state.error) {
          // Native model loaders can exit the process instead of raising an error.
          this.onEvent({ type: 'error', message: state.loaded ? 'The local speech engine stopped unexpectedly.'
            : 'The speech model could not be loaded; its files may be damaged. Download it again in Caption settings.' });
        }
        this.onEvent({ type: 'stopped' });
      }
      resolve(true);
    }));
    return { started: true, profile: profile.id };
  }

  async stop() {
    const state = this.worker;
    if (!state) return false;
    if (!state.stopping) {
      state.stopping = true;
      this.onEvent({ type: 'status', state: 'stopping', message: 'Finishing captions…' });
      if (!state.child.stdin.destroyed) state.child.stdin.end('stop\n');
      state.stopTimer = setTimeout(() => {
        // Kill only this session's process tree if native inference cannot stop.
        if (state.child.pid) {
          execFile('taskkill.exe', ['/PID', String(state.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        }
      }, 15000);
    }
    return state.finished;
  }
}

module.exports = { CaptionService };
