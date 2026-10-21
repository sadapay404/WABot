import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildConfig } from '../src/config/index.js';
import { getMemoryDb } from '../src/database/index.js';
import { createLogger } from '../src/core/logger.js';
import { Dispatcher } from '../src/core/dispatcher.js';
import { MockWhatsAppSocket } from '../src/core/mockSocket.js';
import { normalize } from '../src/core/message.js';
import { OutboundQueue } from '../src/core/outboundQueue.js';
import { PluginLoader } from '../src/core/pluginLoader.js';
import { ChatContext } from '../src/core/chatContext.js';

const quiet = createLogger('fatal');
const ROOT = path.resolve(import.meta.dirname, '..');
const OWNER = '15550009999@s.whatsapp.net';
const MAIN = '15550008888@s.whatsapp.net';
const BOB = '15550002222@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

async function setup() {
  const db = await getMemoryDb();
  const config = buildConfig({ mode: 'live' });
  config.safety.ownerJids = [OWNER];
  config.safety.typingIndicator = false;
  config.ai.dailyLimit = 200;
  const plugins = new PluginLoader({ dir: path.join(ROOT, 'src', 'plugins'), logger: quiet });
  await plugins.loadAll();
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER, botJid: MAIN });
  const queue = new OutboundQueue(socket, config, quiet);
  queue.attach();
  const calls = [];
  const ai = {
    complete: async (input) => {
      calls.push(input);
      return input.images?.length ? 'I see the quoted image.' : 'Hi there';
    },
  };
  const imageGenerator = {
    configured: () => true,
    async generate() {
      return {
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        mimetype: 'image/jpeg',
        ext: 'jpg',
      };
    },
  };
  const chatContext = new ChatContext({ db });
  const dispatcher = new Dispatcher({ plugins, config, logger: quiet, db });
  dispatcher.bot = { ai, imageGenerator, chatContext, contacts: null, selfJid: MAIN };
  dispatcher.trackSocket(socket);

  const send = async (text, {
    from = BOB,
    jid = BOB,
    fromMe = false,
    upsertType = 'notify',
    id = `m${Math.random()}`,
    quotedMessage = null,
    quotedId = 'quoted-1',
    senderAlt = null,
  } = {}) => {
    const message = quotedMessage
      ? {
          extendedTextMessage: {
            text,
            contextInfo: {
              stanzaId: quotedId,
              participant: from,
              quotedMessage,
            },
          },
        }
      : { conversation: text };
    const raw = {
      key: {
        id,
        remoteJid: jid,
        remoteJidAlt: jid === from ? senderAlt || undefined : undefined,
        participant: jid === from ? undefined : from,
        participantAlt: jid === from ? undefined : senderAlt || undefined,
        fromMe,
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message,
      pushName: 'T',
      upsertType,
    };
    const msg = normalize(raw);
    await dispatcher.handle(socket, msg);
    return msg;
  };
  return { db, socket, send, calls, chatContext, config };
}

test('public .ai is built into live mode for direct chats and groups without PUBLIC_AI_* config', async () => {
  const { socket, send, config } = await setup();
  assert.equal('publicEnabled' in config.ai, false);
  assert.equal('publicGroups' in config.ai, false);

  await send('.ai what is two plus two', { jid: GROUP, from: BOB });
  assert.equal(socket.outbox.at(-1).text, "🤖 *AI's Answer*\n\nHi there");
});

test('linked main account can issue simple and cached-history .ai in all groups without SELF_AI_COMMANDS', async () => {
  const { socket, send, calls, chatContext, config } = await setup();
  assert.equal('selfCommands' in config.ai, false);
  chatContext.record({ id: 'a', jid: GROUP, sender: BOB, isBot: false, text: 'lunch at one?', timestamp: 1 });
  chatContext.record({ id: 'b', jid: GROUP, sender: MAIN, isBot: true, text: 'yes', timestamp: 2 });

  await send('.ai 2 what time was that', { jid: GROUP, fromMe: true, id: 'self-history' });
  assert.match(socket.outbox.at(-1).text, /AI's Answer/);
  assert.match(calls.at(-1).prompt, /lunch at one/);
  assert.match(calls.at(-1).prompt, /Question: what time was that/);

  await send('.ai hello again', { jid: GROUP, fromMe: true, id: 'self-simple' });
  assert.match(socket.outbox.at(-1).text, /AI's Answer/);

  // Replayed outgoing upserts do not duplicate either an AI call or reply.
  const callsBeforeReplay = calls.length;
  const repliesBeforeReplay = socket.outbox.length;
  await send('.ai hello again', { jid: GROUP, fromMe: true, id: 'self-simple' });
  await send('.ai new history replay', { jid: GROUP, fromMe: true, id: 'history-append', upsertType: 'append' });
  assert.equal(calls.length, callsBeforeReplay);
  assert.equal(socket.outbox.length, repliesBeforeReplay);
});

test('linked main account can issue one .imagine prompt in a group', async () => {
  const { socket, send } = await setup();
  await send('.imagine a paper lantern floating over a quiet lake', { jid: GROUP, fromMe: true, id: 'self-imagine' });
  assert.equal(socket.outbox.at(-1).kind, 'image');
  assert.match(socket.outbox.at(-1).caption, /paper lantern/);
});

test('linked main account can use .calc in another chat without opening normal outgoing commands', async () => {
  const { socket, send } = await setup();
  await send('.calc 6 * 7', { jid: GROUP, fromMe: true, id: 'self-calc' });
  assert.equal(socket.outbox.at(-1).text, '🧮 *Equation Solved--Calc*\n\n42');
});

test('public users cannot request cached multi-message history', async () => {
  const { socket, send, calls } = await setup();
  await send('.ai 2 summarize our chat', { jid: GROUP, from: BOB });
  assert.equal(calls.length, 0);
  assert.match(socket.outbox.at(-1).text, /For privacy/);
});

test('reply-to-message .ai sends only quoted text and the new question', async () => {
  const { send, calls } = await setup();
  await send('.ai What does this mean?', {
    jid: GROUP,
    from: BOB,
    quotedMessage: { conversation: 'Only this quoted sentence is sent.' },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Only this quoted sentence is sent/);
  assert.match(calls[0].prompt, /What does this mean/);
  assert.doesNotMatch(calls[0].prompt, /Conversation so far/);
  assert.deepEqual(calls[0].images || [], []);
});

test('reply-to-message .ai can analyse one quoted image and optional caption', async () => {
  const { socket, send, calls } = await setup();
  await send('.ai Read the sign.', {
    jid: GROUP,
    from: BOB,
    quotedMessage: {
      imageMessage: {
        mimetype: 'image/jpeg',
        caption: 'A shop-front sign',
        mediaKey: Buffer.alloc(32).toString('base64'),
        directPath: '/mock-image',
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].images.length, 1);
  assert.match(calls[0].prompt, /A shop-front sign/);
  assert.match(calls[0].prompt, /Read the sign/);
  assert.match(socket.outbox.at(-1).text, /I see the quoted image/);
});

test('controller can persistently block and unblock public provider-backed AI', async () => {
  const { send, calls, socket } = await setup();
  await send('.ai -blist- 15550002222', { from: OWNER, jid: OWNER });
  assert.match(socket.outbox.at(-1).text, /cannot use provider-backed AI/);

  const beforeBlocked = calls.length;
  // A group delivery can identify this same phone by an LID and provide the
  // phone JID in participantAlt; the number block must still apply.
  await send('.ai hello', { from: '22222@lid', senderAlt: BOB, jid: GROUP });
  assert.equal(calls.length, beforeBlocked);
  assert.match(socket.outbox.at(-1).text, /^🤖 /);

  await send('.ai -wlist- 15550002222', { from: OWNER, jid: OWNER });
  assert.match(socket.outbox.at(-1).text, /can use AI commands again/);
  await send('.ai hello', { from: BOB, jid: BOB });
  assert.equal(calls.length, beforeBlocked + 1);
});
