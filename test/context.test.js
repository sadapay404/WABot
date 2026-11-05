import test from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryDb } from '../src/database/index.js';
import { ChatContext } from '../src/core/chatContext.js';
import { StatusFeed } from '../src/core/statusFeed.js';
import { PendingPrompts } from '../src/core/pendingPrompts.js';

const GROUP = '120363000000000001@g.us';
const BOB = '15550002222@s.whatsapp.net';
const ME = '15550009999@s.whatsapp.net';

test('chat transcript keeps both sides, groups included, oldest first', async () => {
  const chat = new ChatContext({ db: await getMemoryDb() });
  chat.record({ id: 'a', jid: GROUP, sender: BOB, isBot: false, text: 'first', timestamp: 1 });
  chat.record({ id: 'b', jid: GROUP, sender: ME, isBot: true, text: 'second', timestamp: 2 });
  chat.record({ id: 'c', jid: GROUP, sender: BOB, isBot: false, text: 'third', timestamp: 3 });
  const rows = chat.recent(GROUP, 2);
  assert.deepEqual(rows.map((r) => r.text), ['second', 'third']);
  assert.equal(rows[0].from_me, 1);
});

test('AI answers, status broadcasts and sensitive messages are never stored', async () => {
  const chat = new ChatContext({ db: await getMemoryDb() });
  assert.equal(chat.record({ id: 'x', jid: BOB, sender: ME, isBot: true, text: "🤖 *AI's Answer*\n\nhi", timestamp: 1 }), false);
  assert.equal(chat.record({ id: 'y', jid: 'status@broadcast', sender: BOB, text: 'story', timestamp: 1 }), false);
  assert.equal(chat.record({ id: 'z', jid: BOB, sender: BOB, text: 'secret', sensitive: true, timestamp: 1 }), false);
  assert.deepEqual(chat.recent(BOB, 5), []);
});

test('status feed stores and revives media keys as bytes', async () => {
  const feed = new StatusFeed({ db: await getMemoryDb(), now: () => 1_000_000 });
  const raw = {
    key: { id: 'S1', remoteJid: 'status@broadcast', participant: BOB, fromMe: false },
    message: { imageMessage: { mediaKey: new Uint8Array([1, 2, 3]), caption: 'hi' } },
  };
  const ok = feed.record(raw, { text: 'hi', timestamp: 999, media: { type: 'image' } });
  assert.equal(ok, true);
  const listed = feed.list(10);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].has_media, 1);
  const row = feed.get('S1');
  assert.ok(Buffer.isBuffer(row.raw.message.imageMessage.mediaKey));
  assert.deepEqual([...row.raw.message.imageMessage.mediaKey], [1, 2, 3]);
  assert.equal(row.phone, '15550002222');
});

test('status feed ignores non-status messages and lists newest first', async () => {
  const feed = new StatusFeed({ db: await getMemoryDb(), now: () => 5_000_000 });
  assert.equal(feed.record({ key: { id: 'n', remoteJid: BOB, participant: BOB } }, {}), false);
  feed.record({ key: { id: 'old', remoteJid: 'status@broadcast', participant: BOB } }, { timestamp: 1000, text: 'old' });
  feed.record({ key: { id: 'new', remoteJid: 'status@broadcast', participant: BOB } }, { timestamp: 2000, text: 'new' });
  assert.deepEqual(feed.list(10).map((r) => r.id), ['new', 'old']);
});

test('pending prompts expire and are consumed once', () => {
  let now = 0;
  const prompts = new PendingPrompts({ ttlMs: 1000, now: () => now });
  prompts.set(BOB, { onReply() {} });
  assert.equal(prompts.has(BOB), true);
  assert.ok(prompts.take(BOB));
  assert.equal(prompts.take(BOB), null);
  prompts.set(BOB, { onReply() {} });
  now = 1500;
  assert.equal(prompts.has(BOB), false);
});
