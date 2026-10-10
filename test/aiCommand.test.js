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
const BOB = '15550002222@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

async function setup({ cooldown = 15 } = {}) {
  const db = await getMemoryDb();
  const config = buildConfig({ mode: 'dry-run' });
  config.safety.ownerJids = [OWNER];
  config.safety.typingIndicator = false;
  config.ai.senderCooldownSec = cooldown;
  config.ai.dailyLimit = 200;
  const plugins = new PluginLoader({ dir: path.join(ROOT, 'src', 'plugins'), logger: quiet });
  await plugins.loadAll();
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER, botJid: OWNER });
  const queue = new OutboundQueue(socket, config, quiet);
  queue.attach();
  const prompts = [];
  const ai = { complete: async ({ prompt }) => { prompts.push(prompt); return 'Hi there'; } };
  const chatContext = new ChatContext({ db });
  const dispatcher = new Dispatcher({ plugins, config, logger: quiet, db });
  dispatcher.bot = { ai, chatContext, contacts: null };
  dispatcher.trackSocket(socket);
  const send = async (text, { from = BOB, jid = BOB } = {}) => {
    const raw = {
      key: { id: `m${Math.random()}`, remoteJid: jid, participant: jid === from ? undefined : from, fromMe: false },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: text },
      pushName: 'T',
    };
    const msg = normalize(raw);
    await dispatcher.handle(socket, msg);
    return msg;
  };
  return { socket, send, prompts, chatContext, config };
}

test('.ai answers with the AI\'s Answer label, from any chat', async () => {
  const { socket, send } = await setup();
  await send('.ai what is two plus two', { jid: GROUP, from: BOB });
  assert.equal(socket.outbox.at(-1).text, "🤖 *AI's Answer*\n\nHi there");
});

test('.ai shows usage for a bare count and rejects counts over the limit', async () => {
  const { socket, send } = await setup();
  await send('.ai 3', { jid: GROUP, from: BOB });
  assert.match(socket.outbox.at(-1).text, /usage: \.ai <question>/);
  await send('.ai 500 hello', { jid: GROUP, from: OWNER });
  assert.match(socket.outbox.at(-1).text, /between 1 and 50/);
});

test('.ai <n> passes the last n messages of that chat, both sides', async () => {
  const { send, prompts, chatContext } = await setup();
  chatContext.record({ id: 'a', jid: GROUP, sender: BOB, isBot: false, text: 'lunch at one?', timestamp: 1 });
  chatContext.record({ id: 'b', jid: GROUP, sender: OWNER, isBot: true, text: 'yes', timestamp: 2 });
  await send('.ai 2 what time was that', { jid: GROUP, from: BOB });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Me: yes/);
  assert.match(prompts[0], /\+15550002222: lunch at one\?/);
  assert.match(prompts[0], /Question: what time was that/);
});

test('per-sender cooldown blocks a second question from the same person', async () => {
  const { socket, send, prompts } = await setup({ cooldown: 60 });
  await send('.ai first', { jid: GROUP, from: BOB });
  await send('.ai second', { jid: GROUP, from: BOB });
  assert.equal(prompts.length, 1);
  assert.match(socket.outbox.at(-1).text, /Please wait \d+s/);
});
