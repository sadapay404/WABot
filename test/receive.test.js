import test from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryDb } from '../src/database/index.js';
import { createLogger } from '../src/core/logger.js';
import { MessageCache } from '../src/core/messageCache.js';
import { MessageInbox } from '../src/core/messageInbox.js';
import { ContactStore } from '../src/core/contactStore.js';
import { normalize } from '../src/core/message.js';
import receivePlugin from '../src/plugins/receive.js';

const quiet = createLogger('fatal');
const SELF = '15550009999@s.whatsapp.net';
const OWNER = '15550001111@s.whatsapp.net';
const PN = '923001234567@s.whatsapp.net';
const LID = '123456789012345@lid';
const BOB = '15550002222@s.whatsapp.net';

function store(cache, { id, chat = LID, alt = PN, text = '', media = null, viewOnce = false, ts = Date.now() }) {
  let inner = media
    ? { [Object.keys(media)[0]]: { ...media[Object.keys(media)[0]], ...(text ? { caption: text } : {}) } }
    : { conversation: text };
  if (viewOnce) inner = { viewOnceMessageV2: { message: inner } };
  const raw = {
    key: { id, remoteJid: chat, remoteJidAlt: alt, fromMe: false },
    messageTimestamp: Math.floor(ts / 1_000),
    message: inner,
  };
  cache.store(raw, normalize(raw), SELF);
  return raw;
}

function context({ args, db, inbox, contacts, replies, sent, config }) {
  let reads = 0;
  const socket = {
    async readMessages() { reads++; },
    async sendMessage(jid, content) { sent.push({ jid, content }); },
  };
  return {
    args,
    sender: OWNER,
    jid: OWNER,
    isGroup: false,
    config,
    db,
    socket,
    bot: { messageInbox: inbox, contacts, selfJid: SELF },
    reply: async (text) => replies.push(String(text)),
    send: async (jid, content) => sent.push({ jid, content }),
    readCount: () => reads,
  };
}

function testConfig() {
  return { safety: { ownerJids: [OWNER] }, scheduler: { timezone: 'Asia/Karachi' } };
}

test('.receive phone selector reports text, voice notes and view-once media only to the private control chat', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  const contacts = new ContactStore(db, quiet);
  contacts.upsert({ id: PN, name: 'Ayesha' });
  const now = Date.UTC(2026, 9, 10, 10, 0);
  store(cache, { id: 'R-TEXT', text: 'Please bring the documents.', ts: now });
  store(cache, {
    id: 'R-VOICE', text: '', ts: now + 1_000,
    media: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 9, fileLength: 2048 } },
  });
  store(cache, {
    id: 'R-VO', text: 'Look at this', ts: now + 2_000, viewOnce: true,
    media: { imageMessage: { mimetype: 'image/jpeg', fileLength: 4096 } },
  });
  store(cache, {
    id: 'R-LARGE', text: 'Large file', ts: now + 3_000,
    media: { documentMessage: { mimetype: 'application/pdf', fileName: 'large.pdf', fileLength: 17 * 1024 * 1024 } },
  });
  db.prepare(
    `INSERT INTO view_once(stanza_id, session_jid, chat_jid, kind, media_path, captured_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('R-VO', SELF, LID, 'image', '/local/view-once.jpg', now + 2_000);

  const downloads = [];
  const inbox = new MessageInbox({
    db,
    cache,
    mediaStore: { read: (p) => p === '/local/view-once.jpg' ? Buffer.from('archived-view-once') : null },
    socket: {},
    logger: quiet,
    downloader: async (raw) => { downloads.push(raw.key.id); return Buffer.from(`media:${raw.key.id}`); },
  });
  const replies = [];
  const sent = [];
  const ctx = context({ args: ['03001234567', '4'], db, inbox, contacts, replies, sent, config: testConfig() });
  await receivePlugin.execute(ctx);

  const report = replies.join('\n');
  assert.match(report, /Ayesha/);
  assert.match(report, /Please bring the documents/);
  assert.match(report, /voice note/);
  assert.match(report, /view-once photo/);
  assert.match(report, /exceeds the 16 MB per-file limit/);
  assert.equal(sent.length, 2, 'voice note and view-once photo are attached; large media is skipped');
  assert.deepEqual(downloads, ['R-VOICE'], 'oversized media is rejected before download; archived view-once bytes use local storage');
  assert.ok(sent.every((item) => item.jid === OWNER), 'no message is sent to the source chat');
  assert.equal(sent.find((item) => item.content.audio)?.content.ptt, true);
  assert.ok(sent.some((item) => item.content.image), 'archived view-once bytes can be inspected on request');
  assert.equal(ctx.readCount(), 0, 'the receiver never invokes readMessages');
});

test('.receive unread reports chat-level state without labeling cached previews as individually unread', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  const contacts = new ContactStore(db, quiet);
  let mediaReads = 0;
  const inbox = new MessageInbox({
    db, cache, mediaStore: null, socket: {}, logger: quiet,
    downloader: async () => { mediaReads++; return Buffer.from('image'); },
  });
  const now = Date.UTC(2026, 9, 10, 10, 0);
  store(cache, { id: 'U-OLD', chat: BOB, alt: null, text: 'Already read earlier.', ts: now });
  store(cache, { id: 'U-1', chat: BOB, alt: null, text: 'Cached preview one.', ts: now + 1_000 });
  store(cache, {
    id: 'U-2', chat: BOB, alt: null, text: 'Cached preview two.', ts: now + 2_000,
    media: { imageMessage: { mimetype: 'image/jpeg', fileLength: 1024 } },
  });
  inbox.syncChats([
    { id: BOB, unreadCount: 2 },
    { id: PN, unreadCount: -1 },
    { id: OWNER, unreadCount: 0 },
    { id: '15550003333@s.whatsapp.net' },
  ]);

  const replies = [];
  const sent = [];
  const ctx = context({ args: ['unread'], db, inbox, contacts, replies, sent, config: testConfig() });
  await receivePlugin.execute(ctx);
  const report = replies.join('\n');

  assert.match(report, /WhatsApp reports 2 unread/);
  assert.match(report, /Cached preview one/);
  assert.match(report, /Cached preview two/);
  assert.doesNotMatch(report, /Already read earlier/);
  assert.match(report, /not individually identified as unread/);
  assert.match(report, /not confirmed unread messages/);
  assert.match(report, /exact unread message IDs/);
  assert.match(report, /unknown synced unread count/);
  assert.equal(sent.length, 0, 'unread mode never forwards media without an exact unread message ID');
  assert.equal(mediaReads, 0);
  assert.equal(ctx.readCount(), 0);
});

test('.receive ignores unknown and zero unread states rather than inferring from recent cache rows', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  const inbox = new MessageInbox({ db, cache, mediaStore: null, socket: {}, logger: quiet });
  store(cache, { id: 'NOT-UNREAD', chat: BOB, alt: null, text: 'Just recently cached.' });
  inbox.syncChats([{ id: BOB, unreadCount: -1 }, { id: PN, unreadCount: 0 }]);
  const replies = [];
  const ctx = context({ args: ['unread'], db, inbox, contacts: null, replies, sent: [], config: testConfig() });

  await receivePlugin.execute(ctx);
  assert.match(replies.at(-1), /No chats have a positive synced unread count/);
  assert.match(replies.at(-1), /unknown count; they were not treated as unread/);
  assert.doesNotMatch(replies.at(-1), /Just recently cached/);
  assert.equal(ctx.readCount(), 0);
});
