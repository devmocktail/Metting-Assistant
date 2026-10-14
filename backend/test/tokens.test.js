'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTokenCodec } = require('../src/tokens');

test('sign/verify round trip includes iat/exp', () => {
  const c = createTokenCodec('s');
  const t = c.sign({ email: 'a@b.com' }, 10000);
  const p = c.verify(t);
  assert.equal(p.email, 'a@b.com');
  assert.ok(p.iat > 0 && p.exp > p.iat);
});

test('rejects tampered token', () => {
  const c = createTokenCodec('s');
  const t = c.sign({ x: 1 }, 1000);
  assert.equal(c.verify(t + 'x'), null);
  const [body] = t.split('.');
  assert.equal(c.verify(body + '.AAAA'), null);
});

test('rejects wrong secret', () => {
  const a = createTokenCodec('s1');
  const b = createTokenCodec('s2');
  assert.equal(b.verify(a.sign({ x: 1 }, 1000)), null);
});

test('rejects expired token', () => {
  const c = createTokenCodec('s');
  assert.equal(c.verify(c.sign({ x: 1 }, -1)), null);
});

test('rejects junk input', () => {
  const c = createTokenCodec('s');
  for (const j of ['', 'abc', '.', 'a.', '.b', null, undefined, 123]) {
    assert.equal(c.verify(j), null);
  }
});

test('requires a secret', () => {
  assert.throws(() => createTokenCodec(''));
});
