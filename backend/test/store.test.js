'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { MemoryStore, JsonStore } = require('../src/store');

test('memory: upsert, get (normalized), list, delete', async () => {
  const s = new MemoryStore();
  await s.init();
  assert.equal(s.getUser('A@B.com'), null);
  await s.upsertUser('A@B.com', () => ({ status: 'pending' }));
  const u = s.getUser('a@b.com');
  assert.equal(u.status, 'pending');
  assert.equal(u.email, 'a@b.com'); // base sets normalized email
  assert.equal(s.listUsers().length, 1);
  assert.equal(await s.deleteUser('a@b.com'), true);
  assert.equal(await s.deleteUser('a@b.com'), false);
});

test('memory: upsert mutator sees previous value', async () => {
  const s = new MemoryStore();
  await s.init();
  await s.upsertUser('x@y.com', () => ({ status: 'pending', n: 1 }));
  const after = await s.upsertUser('x@y.com', (prev) => ({ ...prev, n: prev.n + 1 }));
  assert.equal(after.n, 2);
});

test('audit is capped and returned newest-first', async () => {
  const s = new MemoryStore();
  await s.init();
  for (let i = 0; i < 1005; i++) await s.appendAudit({ ts: String(i), action: 'x' });
  const recent = s.listAudit(10);
  assert.equal(recent.length, 10);
  assert.equal(recent[0].ts, '1004');
  assert.ok(s.state.audit.length <= 1000);
});

test('json: persists across store instances (atomic file)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maa-store-'));
  const file = path.join(dir, 'users.json');
  const s1 = new JsonStore(file);
  await s1.init();
  await s1.upsertUser('p@q.com', () => ({ status: 'approved' }));
  await s1.appendAudit({ ts: 't', action: 'signup', target: 'p@q.com' });

  const s2 = new JsonStore(file);
  await s2.init();
  assert.equal(s2.getUser('p@q.com').status, 'approved');
  assert.equal(s2.listAudit(5).length, 1);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('json: missing file initializes empty', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maa-store-'));
  const s = new JsonStore(path.join(dir, 'nope.json'));
  await s.init();
  assert.deepEqual(s.listUsers(), []);
  await fsp.rm(dir, { recursive: true, force: true });
});
