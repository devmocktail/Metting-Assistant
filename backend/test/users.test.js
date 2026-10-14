'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MemoryStore } = require('../src/store');
const { buildConfig } = require('../src/config');
const users = require('../src/users');

function cfg(over) {
  return buildConfig({ NODE_ENV: 'test', AUTH_MODE: 'stub', SESSION_SECRET: 's', ADMIN_TOKEN: 't', ADMIN_EMAILS: 'admin@corp.com', ...over });
}
async function freshStore() {
  const s = new MemoryStore();
  await s.init();
  return s;
}

test('signIn: new user is pending; admin email auto-approved', async () => {
  const s = await freshStore();
  const config = cfg();
  const u = await users.signIn(s, config, { sub: '1', email: 'User@Corp.com', name: 'User' });
  assert.equal(u.status, 'pending');
  assert.equal(u.email, 'user@corp.com');
  assert.equal(users.isAllowed(config, u), false);

  const a = await users.signIn(s, config, { sub: '2', email: 'admin@corp.com', name: 'Boss' });
  assert.equal(a.status, 'approved');
  assert.equal(users.isAllowed(config, a), true);
  assert.equal(users.isAdminEmail(config, 'ADMIN@corp.com'), true);
});

test('signIn twice keeps status, refreshes lastSeen/name', async () => {
  const s = await freshStore();
  const config = cfg();
  const u1 = await users.signIn(s, config, { sub: '1', email: 'u@corp.com', name: 'Old' });
  await users.setStatus(s, config, 'admin@corp.com', 'u@corp.com', 'approved');
  const u2 = await users.signIn(s, config, { sub: '1', email: 'u@corp.com', name: 'New Name' });
  assert.equal(u2.status, 'approved'); // not reset to pending
  assert.equal(u2.name, 'New Name');
  assert.ok(u2.lastSeenAt >= u1.lastSeenAt);
});

test('approve then ban flips allowed', async () => {
  const s = await freshStore();
  const config = cfg();
  await users.signIn(s, config, { sub: '1', email: 'u@corp.com' });
  await users.setStatus(s, config, 'admin@corp.com', 'u@corp.com', 'approved');
  assert.equal(users.isAllowed(config, s.getUser('u@corp.com')), true);
  await users.setStatus(s, config, 'admin@corp.com', 'u@corp.com', 'banned');
  assert.equal(users.isAllowed(config, s.getUser('u@corp.com')), false);
});

test('pre-approve creates a record so first sign-in is allowed', async () => {
  const s = await freshStore();
  const config = cfg();
  await users.setStatus(s, config, 'admin@corp.com', 'new@corp.com', 'approved');
  const u = await users.signIn(s, config, { sub: '9', email: 'new@corp.com' });
  assert.equal(u.status, 'approved');
  assert.equal(users.isAllowed(config, u), true);
});

test('invalid status + invalid email rejected', async () => {
  const s = await freshStore();
  const config = cfg();
  await assert.rejects(() => users.setStatus(s, config, 'admin@corp.com', 'x@corp.com', 'nope'));
  await assert.rejects(() => users.setStatus(s, config, 'admin@corp.com', 'bad-email', 'approved'));
});

test('remove deletes and audits', async () => {
  const s = await freshStore();
  const config = cfg();
  await users.signIn(s, config, { sub: '1', email: 'u@corp.com' });
  assert.equal(await users.remove(s, 'admin@corp.com', 'u@corp.com'), true);
  assert.equal(s.getUser('u@corp.com'), null);
  assert.equal(await users.remove(s, 'admin@corp.com', 'u@corp.com'), false);
  const audit = s.listAudit(10);
  assert.ok(audit.some((a) => a.action === 'delete'));
});

test('listUsers marks admin + allowed and sorts', async () => {
  const s = await freshStore();
  const config = cfg();
  await users.signIn(s, config, { sub: '1', email: 'a@corp.com' });
  await users.signIn(s, config, { sub: '2', email: 'admin@corp.com' });
  const list = users.listUsers(s, config);
  assert.equal(list.length, 2);
  const admin = list.find((u) => u.email === 'admin@corp.com');
  assert.equal(admin.admin, true);
  assert.equal(admin.allowed, true);
});
