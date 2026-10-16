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

async function setup({ cooldown = 15, publicEnabled = true, publicGroups = true, selfCommands = false } = {}) {
  const db = await getMemoryDb();
  const config = buildConfig({ mode: 'live' });
  config.safety.ownerJids = [OWNER];
  config.safety.typingIndicator = false;
  config.ai.senderCooldownSec = cooldown;
  config.ai.dailyLimit = 200;
  config.ai.publicEnabled = publicEnabled;
  config.ai.publicGroups = publicGroups;
  config.ai.selfCommands = selfCommands;
  config.ai.publicSenderCooldownSec = cooldown;
  config.ai.publicDailyLimit = 200;
  config.ai.publicPerSenderDailyLimit = 200;
  const plugins = new PluginLoader({ dir: path.join(ROOT, 'src', 'plugins'), logger: quiet });
  await plugins.loadAll();
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER, botJid: MAIN });
  const queue = new OutboundQueue(socket, config, quiet);
  queue.attach();
  const prompts = [];
  const ai = { complete: async ({ prompt }) => { prompts.push(prompt); return 'Hi there'; } };
  const chatContext = new ChatContext({ db });
  const dispatcher = new Dispatcher({ plugins, config, logger: quiet, db });
  dispatcher.bot = { ai, chatContext, contacts: null, selfJid: MAIN };
  dispatcher.trackSocket(socket);
  const send = async (text, { from = BOB, jid = BOB, fromMe = false, upsertType = 'notify', id = `m${Math.random()}` } = {}) => {
    const raw = {
      key: { id, remoteJid: jid, participant: jid === from ? undefined : from, fromMe },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: text },
      pushName: 'T',
      upsertType,
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

test('the linked main account can deliberately use simple .ai in another chat only after self-command opt-in', async () => {
  const blocked = await setup({ selfCommands: false });
  await blocked.send('.ai Who is the CEO of Xiaomi?', { jid: BOB, fromMe: true });
  assert.equal(blocked.socket.outbox.length, 0);

  const enabled = await setup({ selfCommands: true });
  await enabled.send('.ai Who is the CEO of Xiaomi?', { jid: BOB, fromMe: true, id: 'self-ai-1' });
  assert.match(enabled.socket.outbox.at(-1).text, /AI's Answer/);
  // Replayed fromMe upserts must not create a second provider call/reply.
  await enabled.send('.ai Who is the CEO of Xiaomi?', { jid: BOB, fromMe: true, id: 'self-ai-1' });
  assert.equal(enabled.socket.outbox.length, 1);

  // The linked account cannot use the `.ai <n>` history-export form.
  await enabled.send('.ai 2 summarize our chat', { jid: BOB, fromMe: true, id: 'self-ai-context' });
  assert.equal(enabled.socket.outbox.length, 1);
});

test('public .ai is silent unless explicitly enabled for the chat type', async () => {
  const disabled = await setup({ publicEnabled: false });
  await disabled.send('.ai hello', { jid: BOB, from: BOB });
  assert.equal(disabled.socket.outbox.length, 0);

  const noGroups = await setup({ publicGroups: false });
  await noGroups.send('.ai hello', { jid: GROUP, from: BOB });
  assert.equal(noGroups.socket.outbox.length, 0);
  await noGroups.send('.ai hello', { jid: BOB, from: BOB });
  assert.match(noGroups.socket.outbox.at(-1).text, /AI's Answer/);
});

test('.ai shows usage for a bare count and rejects counts over the limit', async () => {
  const { socket, send } = await setup();
  await send('.ai 3', { jid: GROUP, from: BOB });
  assert.match(socket.outbox.at(-1).text, /usage: \.ai <question>/);
  await send('.ai 500 hello', { jid: GROUP, from: OWNER });
  assert.match(socket.outbox.at(-1).text, /between 1 and 50/);
});

test('.ai <n> passes chat context only for the owner, not a public group participant', async () => {
  const { socket, send, prompts, chatContext } = await setup();
  chatContext.record({ id: 'a', jid: GROUP, sender: BOB, isBot: false, text: 'lunch at one?', timestamp: 1 });
  chatContext.record({ id: 'b', jid: GROUP, sender: OWNER, isBot: true, text: 'yes', timestamp: 2 });

  await send('.ai 2 what time was that', { jid: GROUP, from: BOB });
  assert.equal(prompts.length, 0);
  assert.match(socket.outbox.at(-1).text, /For privacy/);

  await send('.ai 2 what time was that', { jid: GROUP, from: OWNER });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Me: yes/);
  assert.match(prompts[0], /\+15550002222: lunch at one\?/);
  assert.match(prompts[0], /Question: what time was that/);
});

test('public per-sender cooldown silently blocks a second question from the same person', async () => {
  const { socket, send, prompts } = await setup({ cooldown: 60 });
  await send('.ai first', { jid: GROUP, from: BOB });
  const replies = socket.outbox.length;
  await send('.ai second', { jid: GROUP, from: BOB });
  assert.equal(prompts.length, 1);
  assert.equal(socket.outbox.length, replies);
});
