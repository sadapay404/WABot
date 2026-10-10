import test from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryDb } from '../src/database/index.js';
import { buildConfig } from '../src/config/index.js';
import { createLogger } from '../src/core/logger.js';
import { AskContext } from '../src/core/askContext.js';
import { MessageCache } from '../src/core/messageCache.js';
import { ContactStore } from '../src/core/contactStore.js';
import { normalize } from '../src/core/message.js';
import { localDateRange } from '../src/lib/when.js';
import askPlugin from '../src/plugins/ask.js';

const quiet = createLogger('fatal');
const SELF = '15550009999@s.whatsapp.net';
const OWNER = '15550001111@s.whatsapp.net';
const ALICE = '15550002222@s.whatsapp.net';
const BOB = '15550003333@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

function store(cache, id, jid, text, { fromMe = false, ts = Date.now() } = {}) {
  const raw = {
    key: { id, remoteJid: jid, fromMe },
    messageTimestamp: Math.floor(ts / 1_000),
    message: { conversation: text },
  };
  cache.store(raw, normalize(raw), SELF);
}

function context({ args, db, askContext, contacts, ai, replies, config }) {
  return {
    args,
    sender: OWNER,
    jid: OWNER,
    isGroup: false,
    config,
    db,
    bot: { askContext, contacts, ai, selfJid: SELF },
    reply: async (text) => replies.push(String(text)),
  };
}

test('.ask lists numbered direct chats and asks from both sides of the selected conversation', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  const contacts = new ContactStore(db, quiet);
  contacts.upsertMany([
    { id: ALICE, name: 'Alice' },
    { id: BOB, name: 'Bob' },
  ]);
  const now = Date.now();
  store(cache, 'A1', ALICE, 'Could you send the file?', { ts: now - 3_000 });
  store(cache, 'A2', ALICE, 'I will send it tomorrow.', { fromMe: true, ts: now - 2_000 });
  store(cache, 'B1', BOB, 'A more recent chat', { ts: now - 1_000 });
  store(cache, 'G1', GROUP, 'Group conversation must be deferred');
  store(cache, 'O1', OWNER, 'Control chat must not be offered');
  store(cache, 'S1', SELF, 'Self chat must not be offered');

  const askContext = new AskContext({ db });
  const config = buildConfig({ mode: 'dry-run' });
  config.safety.ownerJids = [OWNER];
  const replies = [];
  let request = null;
  const ai = {
    provider: 'groq',
    configured: () => true,
    async complete(value) { request = value; return 'You could reply: I will send it tomorrow.'; },
  };

  await askPlugin.execute(context({ args: ['chats'], db, askContext, contacts, ai, replies, config }));
  assert.match(replies.at(-1), /Cached one-to-one chats/);
  assert.match(replies.at(-1), /Alice/);
  assert.match(replies.at(-1), /Bob/);
  assert.doesNotMatch(replies.at(-1), /Group conversation|Control chat|Self chat/);

  await askPlugin.execute(context({
    args: ['2', 'all', 'What', 'should', 'I', 'reply?'],
    db, askContext, contacts, ai, replies, config,
  }));
  assert.equal(request.chatKey, undefined, 'selected-chat transcripts must not be stored in AI memory');
  assert.match(request.prompt, /Could you send the file/);
  assert.match(request.prompt, /I will send it tomorrow/);
  assert.match(replies.at(-1), /You could reply/);
});

test('.ask supports inclusive date ranges, a single local date, and an end date', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  const contacts = new ContactStore(db, quiet);
  const day1 = localDateRange('2026-01-01', 'Asia/Karachi');
  const day2 = localDateRange('2026-01-02', 'Asia/Karachi');
  const day3 = localDateRange('2026-01-03', 'Asia/Karachi');
  store(cache, 'OLDER', ALICE, 'before the selected period', { ts: day1.start - 1_000 });
  store(cache, 'D1', ALICE, 'message on January first', { ts: day1.start + 60_000 });
  store(cache, 'D2', ALICE, 'message on January second', { ts: day2.start + 60_000 });
  store(cache, 'D3', ALICE, 'message on January third', { ts: day3.start + 60_000 });

  const askContext = new AskContext({ db });
  const config = buildConfig({ mode: 'dry-run' });
  config.safety.ownerJids = [OWNER];
  const replies = [];
  let request;
  const ai = {
    provider: 'groq',
    configured: () => true,
    async complete(value) { request = value; return 'Date-scoped answer'; },
  };
  await askPlugin.execute(context({ args: ['chats'], db, askContext, contacts, ai, replies, config }));

  await askPlugin.execute(context({
    args: ['1', 'after', '2026-01-01', 'to', '2026-01-02', 'Summarize', 'that', 'period'],
    db, askContext, contacts, ai, replies, config,
  }));
  assert.match(request.prompt, /message on January first/);
  assert.match(request.prompt, /message on January second/);
  assert.doesNotMatch(request.prompt, /before the selected period|message on January third/);
  assert.match(replies.at(-1), /2026-01-01 through 2026-01-02/);

  await askPlugin.execute(context({
    args: ['1', 'on', '2026-01-02', 'What', 'happened?'],
    db, askContext, contacts, ai, replies, config,
  }));
  assert.match(request.prompt, /message on January second/);
  assert.match(request.prompt, /\[2026-01-02 00:01\]/, 'transcript timestamps use the selected local timezone');
  assert.match(request.prompt, /Timestamps use Asia\/Karachi/);
  assert.doesNotMatch(request.prompt, /January first|January third/);

  await askPlugin.execute(context({
    args: ['1', 'to', '2026-01-01', 'Summarize', 'up', 'to', 'then'],
    db, askContext, contacts, ai, replies, config,
  }));
  assert.match(request.prompt, /before the selected period/);
  assert.match(request.prompt, /message on January first/);
  assert.doesNotMatch(request.prompt, /January second|January third/);
});

test('.ask requires the numbered snapshot and does not read group history', async () => {
  const db = await getMemoryDb();
  const askContext = new AskContext({ db });
  const config = buildConfig({ mode: 'dry-run' });
  config.safety.ownerJids = [OWNER];
  const replies = [];
  const ctx = context({ args: ['groups'], db, askContext, contacts: null, ai: null, replies, config });
  await askPlugin.execute(ctx);
  assert.match(replies.at(-1), /Group chat selection is not enabled yet/);

  ctx.args = ['1', '20', 'summarize'];
  await askPlugin.execute(ctx);
  assert.match(replies.at(-1), /list expired|Run `\.ask chats`/i);
});
