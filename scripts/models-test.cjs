// Model catalog and downloader tests against a local server that misbehaves on
// purpose (cut connections, ignored ranges, corrupt bytes, redirects, cancel).
//   node --test scripts/models-test.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MODELS, assess, describeCheck, download, recommend } = require('../src/models');

const pc = (overrides = {}) => ({ arch: 'x64', memoryGB: 16, threads: 16, cpu: 'test', ...overrides });

test('Parakeet is suggested for a typical laptop; the others are rated by fit', () => {
  assert.equal(recommend(pc()), 'parakeet');
  assert.equal(assess(MODELS[0], pc()).fit, 'good');
  assert.equal(assess(MODELS[1], pc()).fit, 'slow');
  assert.equal(assess(MODELS[2], pc()).fit, 'slow');
  assert.deepEqual(MODELS.map(m => m.id), ['parakeet', 'whisper-small', 'whisper-turbo']);
});

test('unsupported and low-memory PCs get no suggestion', () => {
  assert.equal(recommend(pc({ arch: 'arm64' })), null);
  assert.equal(assess(MODELS[0], pc({ arch: 'arm64' })).fit, 'unsupported');
  assert.equal(recommend(pc({ memoryGB: 3 })), null);
  assert.match(assess(MODELS[2], pc({ memoryGB: 6 })).note, /8 GB/);
});

test('a PC with few threads still gets the best model, flagged as possibly slow', () => {
  assert.equal(recommend(pc({ threads: 2 })), 'parakeet');
  assert.equal(assess(MODELS[0], pc({ threads: 2 })).fit, 'slow');
});

test('speed check results read as plain advice', () => {
  assert.match(describeCheck({ update_seconds: 1.4 }), /Keeps up/);
  assert.match(describeCheck({ update_seconds: 4.6 }), /several seconds behind/);
  assert.match(describeCheck({ update_seconds: 9 }), /Too slow/);
  assert.equal(describeCheck(null), null);
});

function fakeModel() {
  const big = crypto.randomBytes(700 * 1024);
  const small = Buffer.from('tokens\n');
  const entry = (name, data) => ({ path: name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  return {
    data: { 'model.bin': big, 'tokens.txt': small },
    model: { id: 'fake', folder: 'fake-model', repository: 'org/fake', revision: 'abc123',
      files: [entry('model.bin', big), entry('tokens.txt', small)] },
  };
}

// Serves /<folder>/<file> by redirecting to /cdn/<file> (exercises redirect-following).
async function server(data, { cutFirstAfter = 0, ignoreRange = false, corrupt = false, slow = false } = {}) {
  const log = [];
  let cut = cutFirstAfter;
  const srv = http.createServer((req, res) => {
    log.push(`${req.url} ${req.headers.range || ''}`);
    const resolve = req.url.match(/^\/org\/fake\/resolve\/abc123\/(.+)$/);
    if (resolve) { res.writeHead(302, { Location: `/cdn/${resolve[1]}` }); return res.end(); }
    const name = req.url.replace(/^\/cdn\//, '');
    let body = data[name];
    if (!body) { res.writeHead(404); return res.end(); }
    if (corrupt) { body = Buffer.from(body); body[0] ^= 0xff; }
    const range = !ignoreRange && /bytes=(\d+)-/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { 'Content-Length': body.length - start });
    const chunk = body.subarray(start);
    if (cut && chunk.length > cut) {  // send part of the file, then drop the connection
      res.write(chunk.subarray(0, cut), () => res.socket.destroy());
      cut = 0;
      return;
    }
    if (slow) {
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= chunk.length || res.destroyed) { clearInterval(timer); return res.end(); }
        res.write(chunk.subarray(offset, offset += 32 * 1024));
      }, 20);
      return;
    }
    res.end(chunk);
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${srv.address().port}`, log, close: () => new Promise(r => srv.close(r)) };
}

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'caption-models-test-'));

test('downloads through a redirect, verifies, and records the installation', async () => {
  const { data, model } = fakeModel();
  const srv = await server(data);
  const root = tempRoot();
  const phases = [];
  await download(model, root, { baseUrl: srv.url, onProgress: p => phases.push(p.phase), retryDelay: 10 });
  await srv.close();
  assert.deepEqual(fs.readFileSync(path.join(root, 'fake-model', 'model.bin')), data['model.bin']);
  assert(!fs.existsSync(path.join(root, 'fake-model', 'model.bin.part')));
  const record = JSON.parse(fs.readFileSync(path.join(root, 'fake-model', 'installation.json'), 'utf8'));
  assert.equal(record.revision, 'abc123');
  assert(phases.includes('verify') && phases.at(-1) === 'installed');
});

test('a dropped connection resumes from where it stopped', async () => {
  const { data, model } = fakeModel();
  const srv = await server(data, { cutFirstAfter: 200 * 1024 });
  const root = tempRoot();
  await download(model, root, { baseUrl: srv.url, retryDelay: 10 });
  await srv.close();
  assert.deepEqual(fs.readFileSync(path.join(root, 'fake-model', 'model.bin')), data['model.bin']);
  // Resumes from the bytes actually saved (some were in flight when the connection dropped).
  assert(srv.log.some(line => /\/cdn\/model\.bin bytes=[1-9]\d*-/.test(line)), srv.log.join('\n'));
});

test('a server that ignores ranges makes the file start over, not corrupt', async () => {
  const { data, model } = fakeModel();
  const srv = await server(data, { cutFirstAfter: 200 * 1024, ignoreRange: true });
  const root = tempRoot();
  await download(model, root, { baseUrl: srv.url, retryDelay: 10 });
  await srv.close();
  assert.deepEqual(fs.readFileSync(path.join(root, 'fake-model', 'model.bin')), data['model.bin']);
});

test('corrupt bytes are rejected and the partial file removed', async () => {
  const { data, model } = fakeModel();
  const srv = await server(data, { corrupt: true });
  const root = tempRoot();
  await assert.rejects(download(model, root, { baseUrl: srv.url, retryDelay: 10 }), /integrity check/);
  await srv.close();
  assert(!fs.existsSync(path.join(root, 'fake-model', 'model.bin')));
  assert(!fs.existsSync(path.join(root, 'fake-model', 'model.bin.part')));
});

test('cancelling keeps the partial file and the next download resumes it', async () => {
  const { data, model } = fakeModel();
  const srv = await server(data, { slow: true });
  const root = tempRoot();
  const controller = new AbortController();
  const running = download(model, root, {
    baseUrl: srv.url, signal: controller.signal, retryDelay: 10,
    onProgress: p => { if (p.phase === 'download' && p.done > 100 * 1024) controller.abort(); },
  });
  await assert.rejects(running, /cancelled/);
  const part = path.join(root, 'fake-model', 'model.bin.part');
  const kept = fs.statSync(part).size;
  assert(kept > 0 && kept < data['model.bin'].length);
  await download(model, root, { baseUrl: srv.url, retryDelay: 10 });
  await srv.close();
  assert.deepEqual(fs.readFileSync(path.join(root, 'fake-model', 'model.bin')), data['model.bin']);
  assert(srv.log.some(line => new RegExp(`bytes=${kept}-`).test(line)), srv.log.join('\n'));
});
