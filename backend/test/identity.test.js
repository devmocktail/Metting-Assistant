'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createIdentityResolver, isEmail } = require('../src/identity');

test('isEmail basics', () => {
  assert.ok(isEmail('a@b.com'));
  assert.ok(isEmail('first.last+tag@sub.example.co'));
  assert.ok(!isEmail('nope'));
  assert.ok(!isEmail('a@b'));
  assert.ok(!isEmail(''));
  assert.ok(!isEmail(null));
});

test('stub resolve parses email + name and lowercases', async () => {
  const r = createIdentityResolver({ authMode: 'stub' });
  const id = await r.resolve('stub:Foo@Bar.com:Foo Bar');
  assert.equal(id.email, 'foo@bar.com');
  assert.equal(id.name, 'Foo Bar');
  assert.equal(id.sub, 'stub:foo@bar.com');
  assert.equal(id.emailVerified, true);
});

test('stub resolve without name defaults name to email', async () => {
  const r = createIdentityResolver({ authMode: 'stub' });
  const id = await r.resolve('stub:x@y.com');
  assert.equal(id.email, 'x@y.com');
  assert.equal(id.name, 'x@y.com');
});

test('stub rejects bad tokens', async () => {
  const r = createIdentityResolver({ authMode: 'stub' });
  await assert.rejects(() => r.resolve('notstub'));
  await assert.rejects(() => r.resolve('stub:bademail'));
  await assert.rejects(() => r.resolve(''));
  await assert.rejects(() => r.resolve(123));
});

test('google mode rejects empty token without network', async () => {
  const r = createIdentityResolver({ authMode: 'google', googleClientId: 'cid' });
  await assert.rejects(() => r.resolve(''), /idToken required/);
});
