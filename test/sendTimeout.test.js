import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../src/core/outboundQueue.js';

test('withTimeout resolves a send that settles in time', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000, 'send'), 'ok');
});

test('withTimeout rejects a send that never settles, so the queue slot is freed', async () => {
  const never = new Promise(() => {});
  await assert.rejects(withTimeout(never, 30, 'send'), /send timed out/);
});

test('withTimeout passes through a real rejection unchanged', async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1000, 'send'), /boom/);
});
