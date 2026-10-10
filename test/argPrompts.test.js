import test from 'node:test';
import assert from 'node:assert/strict';

import { buildConfig } from '../src/config/index.js';
import { getMemoryDb } from '../src/database/index.js';
import { createLogger } from '../src/core/logger.js';
import { Dispatcher } from '../src/core/dispatcher.js';
import { MockWhatsAppSocket } from '../src/core/mockSocket.js';
import { normalize } from '../src/core/message.js';
import { OutboundQueue } from '../src/core/outboundQueue.js';
import { PendingPrompts } from '../src/core/pendingPrompts.js';

const quiet = createLogger('fatal');
const OWNER = '15550009999@s.whatsapp.net';
const BOB = '15550002222@s.whatsapp.net';

function setup(plugin) {
  const config = buildConfig({ mode: 'dry-run' });
  config.safety.ownerJids = [OWNER];
  config.safety.typingIndicator = false;
  const plugins = { resolve: (name) => (name === plugin.name ? plugin : null) };
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER, botJid: OWNER });
  const queue = new OutboundQueue(socket, config, quiet);
  queue.attach();
  const dispatcher = new Dispatcher({ plugins, config, logger: quiet, db: null });
  dispatcher.bot = { prompts: new PendingPrompts() };
  dispatcher.trackSocket(socket);
  const send = async (text, { from = BOB, jid = BOB, fromMe = false } = {}) => {
    const raw = {
      key: { id: `m${Math.random()}`, remoteJid: jid, participant: jid === from ? undefined : from, fromMe },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: text },
      pushName: 'T',
    };
    await dispatcher.handle(socket, normalize(raw));
  };
  return { socket, dispatcher, send };
}

const pairPlugin = (ran) => ({
  name: 'pair',
  ownerOnly: false,
  requires: [
    { index: 0, name: 'name', prompt: 'Which name?', validate: (v) => (/^[a-z]+$/.test(v) ? v : null) },
    { index: 1, name: 'count', prompt: 'How many?', validate: (v) => (/^\d$/.test(v) ? Number(v) : null) },
  ],
  async execute(ctx) {
    ran.push(ctx.args);
    await ctx.reply(`done ${ctx.args.join(' ')}`);
  },
});

test('a command with no arguments runs as before (no question asked)', async () => {
  const ran = [];
  const { send } = setup(pairPlugin(ran));
  await send('.pair');
  assert.deepEqual(ran, [[]]);
});

test('a partly filled command asks for the missing argument and then runs', async () => {
  const ran = [];
  const { socket, send } = setup(pairPlugin(ran));
  await send('.pair foo');
  assert.equal(ran.length, 0);
  assert.match(socket.outbox.at(-1).text, /How many\?/);

  await send('many');
  assert.match(socket.outbox.at(-1).text, /That is not valid\.\nHow many\?/);
  assert.equal(ran.length, 0);

  await send('7');
  assert.deepEqual(ran, [['foo', 7]]);
  assert.match(socket.outbox.at(-1).text, /done foo 7/);
});

test('an invalid argument typed up front is asked for again', async () => {
  const ran = [];
  const { socket, send } = setup(pairPlugin(ran));
  await send('.pair Foo9 3');
  assert.match(socket.outbox.at(-1).text, /Which name\?/);
  await send('bar');
  assert.deepEqual(ran, [['bar', 3]]);
});

test('an answer from someone else does not satisfy another sender\'s question', async () => {
  const ran = [];
  const GROUP = '120363000000000001@g.us';
  const OTHER = '15550003333@s.whatsapp.net';
  const { send } = setup(pairPlugin(ran));
  await send('.pair foo', { jid: GROUP, from: BOB });
  await send('5', { jid: GROUP, from: OTHER });
  assert.equal(ran.length, 0);
  await send('5', { jid: GROUP, from: BOB });
  assert.deepEqual(ran, [['foo', 5]]);
});

test('status broadcasts are never answered', async () => {
  const ran = [];
  const { socket, send } = setup(pairPlugin(ran));
  await send('.pair foo', { jid: 'status@broadcast', from: BOB });
  assert.equal(socket.outbox.length, 0);
  assert.equal(ran.length, 0);
});
