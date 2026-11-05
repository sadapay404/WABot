import test from 'node:test';
import assert from 'node:assert/strict';

import { isHealthCheckMessage, prioritizeInboundBatch } from '../src/core/inboundBatch.js';

function raw(id, text) {
  return { key: { id, remoteJid: '15550000000@s.whatsapp.net' }, message: { conversation: text } };
}

test('inbound batch moves only health checks ahead of slow ordinary messages', () => {
  const slow = raw('slow', '.ai describe this image');
  const ping = raw('ping', '.ping');
  const normal = raw('normal', 'hello');
  const alias = raw('alias', '.latency now');

  assert.deepEqual(
    prioritizeInboundBatch([slow, ping, normal, alias]).map((item) => item.key.id),
    ['ping', 'alias', 'slow', 'normal']
  );
});

test('inbound batch health detection supports wrapped text and rejects lookalikes', () => {
  const wrapped = {
    key: { id: 'wrapped' },
    message: { ephemeralMessage: { message: { extendedTextMessage: { text: '.P' } } } },
  };
  assert.equal(isHealthCheckMessage(wrapped), true);
  assert.equal(isHealthCheckMessage(raw('not-ping', '.pingpong')), false);
  assert.equal(isHealthCheckMessage(raw('not-command', 'ping')), false);
  assert.equal(isHealthCheckMessage(raw('different-prefix', '!ping')), false);
  assert.equal(isHealthCheckMessage(raw('different-prefix', '!ping'), '!'), true);
});
