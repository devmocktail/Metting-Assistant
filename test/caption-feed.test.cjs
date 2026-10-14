'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFeedAssembler } = require('../src/caption-feed');

test('interim updates replace live text; final commits it', () => {
  const f = createFeedAssembler();
  assert.equal(f.update({ id: 'a', text: 'hello', type: 'partial' }), 'hello');
  assert.equal(f.update({ id: 'a', text: 'hello there', type: 'partial' }), 'hello there');
  assert.equal(f.update({ id: 'a', text: 'hello there world', type: 'final' }), 'hello there world');
  assert.equal(f.update({ id: 'b', text: 'next', type: 'partial' }), 'hello there world next');
  assert.equal(f.update({ id: 'b', text: 'next phrase', type: 'final' }), 'hello there world next phrase');
});

test('a final revision is not appended twice', () => {
  const f = createFeedAssembler();
  f.update({ id: 'a', text: 'one', type: 'final' });
  assert.equal(f.update({ id: 'a', text: 'one!', type: 'final', revision: true }), 'one');
});

test('a new phrase starting before the previous finalizes keeps both', () => {
  const f = createFeedAssembler();
  f.update({ id: 'a', text: 'first phrase', type: 'partial' });
  assert.equal(f.update({ id: 'b', text: 'second', type: 'partial' }), 'first phrase second');
  // a's late final must not duplicate
  assert.equal(f.update({ id: 'a', text: 'first phrase', type: 'final' }), 'first phrase second');
  assert.equal(f.update({ id: 'b', text: 'second done', type: 'final' }), 'first phrase second done');
});

test('empty text leaves the transcript unchanged', () => {
  const f = createFeedAssembler();
  f.update({ id: 'a', text: 'hi', type: 'partial' });
  assert.equal(f.update({ id: 'a', text: '', type: 'partial' }), 'hi');
});

test('reset clears everything', () => {
  const f = createFeedAssembler();
  f.update({ id: 'a', text: 'x', type: 'final' });
  f.reset();
  assert.equal(f.desired(), '');
});
