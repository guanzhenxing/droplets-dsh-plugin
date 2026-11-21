import test from 'node:test';
import assert from 'node:assert/strict';
import { FrozenOrder } from '../src/client/frozen-sort.js';

function entry(key, read, title) { return { key, read, title }; }

test('unread entries sort ahead of read ones without reshuffling known order', () => {
  const frozen = new FrozenOrder();
  const first = frozen.order('all', [entry('a', true), entry('b', false), entry('c', false)]);
  assert.deepEqual(first.map((e) => e.key), ['b', 'c', 'a']);
  // Refresh flips b to read and shuffles timestamps: relative order frozen.
  const second = frozen.order('all', [entry('b', true), entry('c', false), entry('a', true)]);
  assert.deepEqual(second.map((e) => e.key), ['c', 'b', 'a'], 'known keys keep session order');
});

test('new entries enter ahead of older ones', () => {
  const frozen = new FrozenOrder();
  frozen.order('all', [entry('a', false)]);
  const next = frozen.order('all', [entry('a', false), entry('new', false)]);
  assert.equal(next[0].key, 'new');
});

test('channels keep independent windows', () => {
  const frozen = new FrozenOrder();
  const feedA = frozen.order('feed:a', [entry('x', false)]);
  const feedB = frozen.order('feed:b', [entry('y', true)]);
  assert.equal(feedA[0].key, 'x');
  assert.equal(feedB[0].key, 'y');
  frozen.reset('feed:a');
  assert.equal(frozen.windows.size, 1);
});
