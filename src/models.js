// Speech models the app can download, ranked for live captions on a CPU, with a
// resumable, verified downloader. Every file is pinned to a repository revision,
// size, and SHA-256. Only explicit user downloads use the network; the caption
// worker itself refuses network access.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream');

const MODELS = [
  {
    id: 'parakeet', engine: 'parakeet', folder: 'parakeet-en', name: 'Parakeet', label: 'Best for live captions',
    summary: 'Most accurate on accented English in tests here, and the fastest: captions within about a second.',
    memoryGB: 1.0, minMemoryGB: 4, live: true,
    repository: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', revision: '1ab9323565ddb038682214b292f588070a538ce2',
    files: [
      { path: 'encoder.int8.onnx', size: 652184296, sha256: 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab' },
      { path: 'decoder.int8.onnx', size: 7257753, sha256: 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e' },
      { path: 'joiner.int8.onnx', size: 1739080, sha256: '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2' },
      { path: 'tokens.txt', size: 9384, sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d' },
    ],
  },
  {
    id: 'whisper-small', engine: 'whisper', folder: 'whisper-small', name: 'Whisper Small', label: 'Alternative',
    summary: 'Less accurate than Parakeet on accented speech in tests here, and captions arrive several seconds later.',
    memoryGB: 0.7, minMemoryGB: 4, live: true,
    repository: 'Systran/faster-whisper-small', revision: '536b0662742c02347bc0e980a01041f333bce120',
    files: [
      { path: 'model.bin', size: 483546902, sha256: '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671' },
      { path: 'config.json', size: 2370, sha256: 'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828' },
      { path: 'tokenizer.json', size: 2203239, sha256: 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab' },
      { path: 'vocabulary.txt', size: 459861, sha256: '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913' },
    ],
  },
  {
    id: 'whisper-turbo', engine: 'whisper', folder: 'whisper-large-v3-turbo', name: 'Whisper Turbo', label: 'Largest',
    summary: 'Largest download. Too slow for live captions on most laptops: about 9 s per update on a 12-core laptop.',
    memoryGB: 1.9, minMemoryGB: 8, live: false,
    repository: 'dropbox-dash/faster-whisper-large-v3-turbo', revision: '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
    files: [
      { path: 'model.bin', size: 1617884929, sha256: 'e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da' },
      { path: 'config.json', size: 2263, sha256: 'b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e' },
      { path: 'preprocessor_config.json', size: 340, sha256: '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711' },
      { path: 'tokenizer.json', size: 2710337, sha256: '297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd' },
      { path: 'vocabulary.json', size: 1068114, sha256: 'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1' },
    ],
  },
];

const downloadBytes = model => model.files.reduce((sum, file) => sum + file.size, 0);

function isInstalled(model, root) {
  return model.files.every(file => {
    try { return fs.statSync(path.join(root, model.folder, file.path)).size === file.size; } catch { return false; }
  });
}

function machine() {
  const cpus = os.cpus();
  return { arch: process.arch, memoryGB: os.totalmem() / 2 ** 30, threads: cpus.length, cpu: (cpus[0]?.model || '').trim() };
}

// How well a model should suit this PC before any download. The speed check
// after installation measures it directly.
function assess(model, pc) {
  const gb = value => `${Math.round(value)} GB`;
  if (pc.arch !== 'x64') return { fit: 'unsupported', note: 'This build runs on 64-bit Intel or AMD Windows PCs.' };
  if (pc.memoryGB < model.minMemoryGB) return { fit: 'unsuitable', note: `Needs ${gb(model.minMemoryGB)} of memory or more; this PC has ${gb(pc.memoryGB)}.` };
  if (!model.live) return { fit: 'slow', note: 'Expect captions to fall behind live speech.' };
  if (pc.threads < 4) return { fit: 'slow', note: 'This PC has few processor threads, so captions may lag.' };
  return model.id === 'parakeet'
    ? { fit: 'good', note: `Suits this PC (${gb(pc.memoryGB)} memory, ${pc.threads} processor threads).` }
    : { fit: 'slow', note: 'Runs on this PC, a few seconds behind live speech.' };
}

function recommend(pc = machine()) {
  const order = ['good', 'slow'];
  for (const fit of order) {
    const model = MODELS.find(m => assess(m, pc).fit === fit);
    if (model) return model.id;
  }
  return null;
}

// Speed check result -> how live captions should feel on this PC. Thresholds
// follow live sessions on the test laptop: Parakeet (1.4 s here on battery)
// captioned within about a second; Whisper Small (4.6 s) kept up but ran
// 6-7 s behind; Turbo (about 9 s) fell behind.
function describeCheck(check) {
  if (!check || !Number.isFinite(check.update_seconds)) return null;
  const seconds = check.update_seconds.toFixed(1);
  if (check.update_seconds <= 2) return `Speed check: 6 s of speech recognized in ${seconds} s. Keeps up with live speech.`;
  if (check.update_seconds <= 6) return `Speed check: 6 s of speech recognized in ${seconds} s. Captions run several seconds behind.`;
  return `Speed check: 6 s of speech took ${seconds} s. Too slow for live captions on this PC.`;
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// One HTTP(S) range request into `part`, following redirects; resolves when the
// response ends. The caller retries and resumes from the partial file's size.
function fetchInto(url, part, file, onBytes, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (start > file.size) {  // not a prefix of this file: start over
      fs.rmSync(part, { force: true });
      start = 0;
    }
    if (start === file.size) return resolve();
    const get = url.startsWith('https:') ? https.get : http.get;
    const request = get(url, {
      headers: { 'User-Agent': 'A2solveX-Meeting-Assistant', ...(start ? { Range: `bytes=${start}-` } : {}) },
      signal,
    }, response => {
      const { statusCode, headers } = response;
      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location && redirects < 8) {
        response.resume();
        return resolve(fetchInto(new URL(headers.location, url).toString(), part, file, onBytes, signal, redirects + 1));
      }
      if (statusCode !== 200 && statusCode !== 206) {
        response.resume();
        return reject(new Error(`Download failed: server answered ${statusCode}.`));
      }
      const append = statusCode === 206 && start > 0;  // 200 means the server restarted the file
      let received = append ? start : 0;
      response.on('data', chunk => { received += chunk.length; onBytes(received); });
      // pipeline closes both streams and fails if the response ends early.
      pipeline(response, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }),
        error => (error ? reject(error) : resolve()));
    });
    request.setTimeout(60000, () => request.destroy(new Error('No data for 60 s.')));
    request.on('error', reject);
  });
}

async function download(model, root, { onProgress = () => {}, signal, baseUrl, retryDelay = 2000 } = {}) {
  const base = baseUrl || process.env.CAPTION_MODEL_BASE_URL || 'https://huggingface.co';
  const dir = path.join(root, model.folder);
  fs.mkdirSync(dir, { recursive: true });
  const total = downloadBytes(model);
  const done = model.files.filter(f => isInstalled({ folder: model.folder, files: [f] }, root));
  let finished = done.reduce((sum, f) => sum + f.size, 0);
  const partial = model.files.reduce((sum, f) => {
    try { return sum + fs.statSync(path.join(dir, `${f.path}.part`)).size; } catch { return sum; }
  }, 0);
  const needed = total - finished - partial;
  if (freeBytes(root) < needed * 1.05) {
    throw new Error(`Not enough disk space: about ${(needed / 2 ** 30).toFixed(1)} GB is needed.`);
  }
  let reported = 0;
  const report = (phase, bytes) => {  // at most four updates a second
    if (phase !== 'download' || Date.now() - reported >= 250) {
      reported = Date.now();
      onProgress({ phase, done: bytes, total });
    }
  };
  for (const file of model.files) {
    if (done.includes(file)) continue;
    const target = path.join(dir, file.path);
    const part = `${target}.part`;
    const url = `${base}/${model.repository}/resolve/${model.revision}/${file.path}`;
    for (let attempt = 1; ; attempt++) {
      try {
        await fetchInto(url, part, file, bytes => report('download', finished + bytes), signal);
        break;
      } catch (error) {
        if (signal?.aborted) throw new Error('Download cancelled. It resumes where it stopped next time.');
        if (attempt === 5) throw error;
        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
      }
    }
    if (fs.statSync(part).size !== file.size) throw new Error(`${file.path} is incomplete. Try again to resume.`);
    report('verify', finished + file.size);
    if (await sha256(part) !== file.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(`${file.path} failed its integrity check and was removed. Try again.`);
    }
    fs.renameSync(part, target);
    finished += file.size;
  }
  fs.writeFileSync(path.join(dir, 'installation.json'), JSON.stringify({
    repository: model.repository, revision: model.revision, verified: new Date().toISOString(),
    files: Object.fromEntries(model.files.map(f => [f.path, { size: f.size, sha256: f.sha256 }])),
  }, null, 2));
  report('installed', total);
}

module.exports = { MODELS, assess, describeCheck, download, downloadBytes, isInstalled, machine, recommend, sha256 };
