import test from 'node:test';
import assert from 'node:assert/strict';

import { OutboundQueue } from '../src/core/outboundQueue.js';
import { createLogger } from '../src/core/logger.js';

const quiet = createLogger('fatal');
const OWNER = '15550001111@s.whatsapp.net';

function config(over = {}) {
  return {
    isObserve: false,
    safety: {
      rateLimitPerMin: 30,
      rateLimitWindowMs: 100,
      queueConcurrency: 1,
      typingIndicator: false,
      outboundLoopThreshold: 20,
      outboundLoopWindowMs: 60_000,
      outboundVolumeLimit: 100,
      outboundVolumeWindowMs: 60_000,
      ownerJids: [OWNER],
      observeAllowReplyToOwner: true,
    },
    ...over,
  };
}

function socket(name, sent = []) {
  return {
    user: { id: OWNER },
    async sendPresenceUpdate() {},
    async sendMessage(jid, content) {
      sent.push({ name, jid, content });
      return { key: { id: `${name}-${sent.length}` } };
    },
  };
}

test('queued work selects the replacement transport at dispatch time', async () => {
  const sent = [];
  const old = socket('old', sent);
  let release;
  const firstStarted = new Promise((resolve) => { release = resolve; });
  let unblock;
  const held = new Promise((resolve) => { unblock = resolve; });
  old.sendMessage = async (jid, content) => {
    if (content.text === 'first') {
      release();
      await held;
    }
    sent.push({ name: 'old', jid, content });
    return { key: { id: content.text } };
  };
  const queue = new OutboundQueue(old, config(), quiet);
  queue.attach();
  const first = old.sendMessage(OWNER, { text: 'first' });
  await firstStarted;
  const second = old.sendMessage(OWNER, { text: 'second' });
  const replacement = socket('new', sent);
  queue.attach(replacement);
  unblock();
  await Promise.all([first, second]);
  assert.equal(sent.find((entry) => entry.content.text === 'second').name, 'new');
});

test('halt during a pre-transport typing await prevents a later send', async () => {
  const sent = [];
  const raw = socket('raw', sent);
  let release;
  const composing = new Promise((resolve) => { release = resolve; });
  raw.sendPresenceUpdate = async (state) => state === 'composing' ? composing : undefined;
  const queue = new OutboundQueue(raw, config({ safety: { ...config().safety, typingIndicator: true } }), quiet);
  queue.attach();
  const pending = raw.sendMessage(OWNER, { text: 'must not send' });
  await new Promise((resolve) => setImmediate(resolve));
  queue.halt('test');
  release();
  await assert.rejects(pending, /halted/);
  assert.equal(sent.length, 0);
});

test('successful transport is not reported failed when advisory presence hangs', async () => {
  const sent = [];
  const raw = socket('raw', sent);
  raw.sendPresenceUpdate = async (state) => state === 'unavailable' ? new Promise(() => {}) : undefined;
  const queue = new OutboundQueue(raw, config(), quiet);
  queue.attach();
  const result = await raw.sendMessage(OWNER, { text: 'delivered' });
  assert.equal(result.key.id, 'raw-1');
  assert.equal(sent.length, 1);
});

test('observe mode blocks non-owner structural sends but permits explicit private owner control', async () => {
  const sent = [];
  const raw = socket('raw', sent);
  const queue = new OutboundQueue(raw, config({ isObserve: true }), quiet);
  queue.attach();
  await assert.rejects(raw.sendMessage('12025550188@s.whatsapp.net', { text: 'scheduled' }), /observe mode/);
  await raw.sendMessage(OWNER, { text: 'owner response' }, { nexusOwnerControl: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, OWNER);
});
