import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveSocket } from '../src/core/socketForwarder.js';

function rawSocket(id) {
  return {
    user: { id },
    sent: [],
    async sendMessage(jid, content) {
      this.sent.push({ jid, content });
      return { key: { id: `${id}-${this.sent.length}` } };
    },
  };
}

test('live socket sends through the replacement raw socket while event listeners stay on the connection relay', async () => {
  const listeners = new Map();
  const first = rawSocket('first@s.whatsapp.net');
  const second = rawSocket('second@s.whatsapp.net');
  const connection = {
    socket: first,
    on(event, listener) {
      const list = listeners.get(event) || [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
  };
  const socket = createLiveSocket(connection);
  const seen = [];
  socket.ev.on('messages.upsert', (payload) => seen.push(payload.id));

  await socket.sendMessage('15550001111@s.whatsapp.net', { text: 'before reconnect' });
  connection.socket = second;
  await socket.sendMessage('15550002222@s.whatsapp.net', { text: 'after reconnect' });
  for (const listener of listeners.get('messages.upsert') || []) listener({ id: 'from-new-socket' });

  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 1, 'outbound sends must use the current raw socket');
  assert.deepEqual(seen, ['from-new-socket'], 'watchers remain subscribed after the raw socket changes');
});
