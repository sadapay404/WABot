/**
 * Nexus-WA — smoke tests.
 *
 * Run with: npm test
 *
 * These exercise the real modules (message.js, pluginLoader.js, dispatcher.js,
 * mockSocket.js) and the real entry point. They are the reason "it worked in
 * dry-run" means something: the same code runs under both transports.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig, validateConfig } from '../src/config/index.js';
import { createLogger } from '../src/core/logger.js';
import { normalize, parseCommand, extractMediaType } from '../src/core/message.js';
import { PluginLoader } from '../src/core/pluginLoader.js';
import { Dispatcher } from '../src/core/dispatcher.js';
import { MockWhatsAppSocket, MOCK_OWNER_JID, MOCK_GROUP_JID } from '../src/core/mockSocket.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = createLogger('fatal');
const OWNER = MOCK_OWNER_JID; // 15550001111@s.whatsapp.net
const STRANGER = '15550002222@s.whatsapp.net';

function rig({ mode = 'dry-run', ownerJids = [] } = {}) {
  const config = buildConfig({ mode });
  config.safety.ownerJids = ownerJids;
  return config;
}

/**
 * Build a raw Baileys-shaped message.
 *
 * Note the DM rule that mirrors WhatsApp itself: in a 1:1 chat the remoteJID
 * IS the other party, so a "sender" only makes sense alongside a group JID.
 * Passing `sender` for a DM therefore sets the chat to that person's JID.
 */
function rawMessage(text, { jid, sender, fromMe = false } = {}) {
  const isGroup = (jid || '').endsWith('@g.us');
  const remoteJid = jid || sender || OWNER;
  return {
    key: {
      remoteJid,
      fromMe,
      id: 'T1',
      participant: isGroup ? sender || STRANGER : undefined,
    },
    pushName: 'Tester',
    messageTimestamp: 1700000000,
    message: { conversation: text },
  };
}

// ══════════════════════════════════════════════════════════════════
test('message.js: normalises a plain DM', () => {
  const m = normalize(rawMessage('.ping hello', { jid: OWNER }));
  assert.equal(m.text, '.ping hello');
  assert.equal(m.isGroup, false);
  assert.equal(m.sender, OWNER);
  assert.equal(m.isBot, false);
  assert.equal(m.media, null);
});

test('message.js: normalises an extendedTextMessage (quoted reply)', () => {
  const m = normalize({
    key: { remoteJid: OWNER, fromMe: false, id: 'T2' },
    message: {
      extendedTextMessage: {
        text: '.ai summarise this',
        contextInfo: { stanzaId: 'Q9', participant: STRANGER, mentionedJid: [STRANGER] },
      },
    },
  });
  assert.equal(m.text, '.ai summarise this');
  assert.equal(m.quoted?.id, 'Q9');
  assert.deepEqual(m.mentions, ['15550002222']);
});

test('message.js: group messages resolve the sender from key.participant', () => {
  const m = normalize(rawMessage('.ping', { jid: MOCK_GROUP_JID, sender: STRANGER }));
  assert.equal(m.isGroup, true);
  assert.equal(m.jid, MOCK_GROUP_JID);
  // The bug this guards against: treating the group JID as the sender.
  assert.equal(m.sender, STRANGER);
  assert.notEqual(m.sender, m.jid);
});

test('message.js: own messages are flagged so the bot never answers itself', () => {
  const m = normalize(rawMessage('.ping', { jid: OWNER, fromMe: true }));
  assert.equal(m.isBot, true);
});

test('message.js: detects audio media for the transcribe pipeline', () => {
  const media = extractMediaType({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 42 } });
  assert.equal(media.type, 'audio');
  assert.equal(media.seconds, 42);
  assert.match(media.mimetype, /opus/);
});

test('message.js: recognizes Baileys unavailable and flat view-once markers', () => {
  const unavailable = normalize({
    key: { remoteJid: OWNER, fromMe: false, id: 'VO-MARKER', isViewOnce: true },
  });
  assert.equal(unavailable.viewOnce, true);
  assert.equal(unavailable.media, null);

  const flat = normalize({
    key: { remoteJid: OWNER, fromMe: false, id: 'VO-FLAT' },
    message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } },
  });
  assert.equal(flat.viewOnce, true);
  assert.equal(flat.media?.type, 'image');
});

test('message.js: parseCommand splits prefix, command and args', () => {
  const m = normalize(rawMessage('.schedule 10m | buy milk', { jid: OWNER }));
  const p = parseCommand(m, '.');
  assert.equal(p.isCommand, true);
  assert.equal(p.command, 'schedule');
  assert.deepEqual(p.args, ['10m', '|', 'buy', 'milk']);
  assert.equal(p.argsRaw, '10m | buy milk');

  assert.equal(parseCommand(normalize(rawMessage('hello there')), '.').isCommand, false);
  assert.equal(parseCommand(normalize(rawMessage('.', { jid: OWNER })), '.').isCommand, false);
});

// ══════════════════════════════════════════════════════════════════
test('pluginLoader: loads valid plugins and quarantines broken ones', async () => {
  const loader = new PluginLoader({ dir: path.join(ROOT, 'test', 'fixtures', 'plugins'), logger: quiet });
  await loader.loadAll();

  assert.equal(loader.commands.has('secret'), true);
  assert.equal(loader.commands.has('boom'), true);
  assert.equal(loader.commands.has('broken'), false);
  assert.equal(loader.failures.length, 1, 'broken.js must be reported, not silently dropped');
  assert.match(loader.failures[0].error, /execute/);
});

test('pluginLoader: resolves aliases', async () => {
  const loader = new PluginLoader({ dir: path.join(ROOT, 'src', 'plugins'), logger: quiet });
  await loader.loadAll();
  assert.equal(loader.resolve('ping').name, 'ping');
  assert.equal(loader.resolve('p').name, 'ping');
  assert.equal(loader.resolve('latency').name, 'ping');
  assert.equal(loader.resolve('nope'), undefined);
});

// ══════════════════════════════════════════════════════════════════
async function dispatchFixture(command, { mode = 'dry-run', ownerJids = [OWNER], from = OWNER, jid } = {}) {
  const config = rig({ mode, ownerJids });
  const loader = new PluginLoader({ dir: path.join(ROOT, 'test', 'fixtures', 'plugins'), logger: quiet });
  await loader.loadAll();
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER });
  const dispatcher = new Dispatcher({ plugins: loader, config, logger: quiet });
  // `jid` stays undefined for DMs so the chat JID is the sender's own JID.
  await dispatcher.handle(socket, normalize(rawMessage(command, { jid, sender: from })));
  return { socket, dispatcher, config };
}

test('gate 1: owner-only command is blocked for a stranger', async () => {
  const { socket, dispatcher } = await dispatchFixture('.secret', { from: STRANGER });
  assert.equal(socket.outbox.length, 0, 'nothing may be sent to an unauthorised user');
  assert.equal(dispatcher.stats.rejected, 1);
  assert.equal(dispatcher.stats.handled, 0);
});

test('gate 1: owner-only command runs for the owner', async () => {
  const { socket } = await dispatchFixture('.secret', { from: OWNER });
  assert.deepEqual(socket.outbox.map((o) => o.text), ['vault opened']);
});

test('gate 1: an unknown command sends nothing and is counted as rejected', async () => {
  const { socket, dispatcher } = await dispatchFixture('.doesnotexist', { from: OWNER });
  assert.equal(socket.outbox.length, 0);
  assert.equal(dispatcher.stats.rejected, 1);
});

test('gate 2: cooldown blocks the second invocation', async () => {
  const config = rig({ mode: 'live', ownerJids: [OWNER] });
  config.telegram.token = 'x';
  config.telegram.ownerId = '1';
  const loader = new PluginLoader({ dir: path.join(ROOT, 'test', 'fixtures', 'plugins'), logger: quiet });
  await loader.loadAll();
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER });
  const dispatcher = new Dispatcher({ plugins: loader, config, logger: quiet });

  const msg = normalize(rawMessage('.slow', { jid: OWNER }));
  await dispatcher.handle(socket, msg);
  await dispatcher.handle(socket, normalize(rawMessage('.slow', { jid: OWNER })));

  assert.equal(socket.outbox.length, 1, 'second call inside the cooldown window must be swallowed');
  assert.equal(dispatcher.stats.rejected, 1);
});

test('gate 3: observe mode swallows commands from non-owners', async () => {
  const { socket, dispatcher, config } = await dispatchFixture('.secret', {
    mode: 'observe',
    from: STRANGER,
  });
  assert.equal(config.isObserve, true);
  assert.equal(socket.outbox.length, 0);
  assert.equal(dispatcher.stats.rejected, 1);
});

test('gate 3: observe mode still answers the owner when opted in', async () => {
  const { socket } = await dispatchFixture('.secret', { mode: 'observe', from: OWNER });
  assert.deepEqual(socket.outbox.map((o) => o.text), ['vault opened']);
});

test('gate 3: observe mode blocks even the owner when the override is off', async () => {
  const config = rig({ mode: 'observe', ownerJids: [OWNER] });
  config.safety.observeAllowReplyToOwner = false;
  const loader = new PluginLoader({ dir: path.join(ROOT, 'test', 'fixtures', 'plugins'), logger: quiet });
  await loader.loadAll();
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER });
  const dispatcher = new Dispatcher({ plugins: loader, config, logger: quiet });
  await dispatcher.handle(socket, normalize(rawMessage('.secret', { jid: OWNER })));
  assert.equal(socket.outbox.length, 0);
});

test('containment: a throwing plugin is caught, reported, and never crashes', async () => {
  const { socket, dispatcher } = await dispatchFixture('.boom', { from: OWNER });
  assert.equal(dispatcher.stats.errors, 1);
  assert.equal(dispatcher.stats.handled, 1);
  assert.match(socket.outbox.at(-1).text, /That command failed: deliberate plugin failure/);
});

test('dispatcher: the bot ignores its own messages (no feedback loop)', async () => {
  const { socket, dispatcher } = await dispatchFixture('.secret', { from: OWNER });
  socket.outbox.length = 0;
  await dispatcher.handle(socket, normalize(rawMessage('.secret', { jid: OWNER, fromMe: true })));
  assert.equal(socket.outbox.length, 0);
  assert.equal(dispatcher.stats.rejected, 0, 'own messages are skipped before authorisation');
});

test('dispatcher: plain chat is ignored entirely', async () => {
  const { socket, dispatcher } = await dispatchFixture('good morning everyone', { from: OWNER });
  assert.equal(socket.outbox.length, 0);
  assert.equal(dispatcher.stats.handled, 0);
});

test('dispatcher: long replies are chunked, not silently truncated', async () => {
  const config = rig({ mode: 'live', ownerJids: [OWNER] });
  const loader = new PluginLoader({ dir: path.join(ROOT, 'test', 'fixtures', 'plugins'), logger: quiet });
  await loader.loadAll();
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER });
  const dispatcher = new Dispatcher({ plugins: loader, config, logger: quiet });

  await dispatcher.handle(socket, normalize(rawMessage('.long', { jid: OWNER })));

  assert.equal(socket.outbox.length, 3, '9000 chars at a 4000 ceiling = 3 messages');
  assert.deepEqual(
    socket.outbox.map((o) => o.text.length),
    [4000, 4000, 1000]
  );
  assert.equal(socket.outbox.map((o) => o.text).join('').length, 9000, 'no characters lost');
});

test('dispatcher: fails closed when no owner is configured anywhere', async () => {
  const config = rig({ mode: 'dry-run', ownerJids: [] });
  const loader = new PluginLoader({ dir: path.join(ROOT, 'test', 'fixtures', 'plugins'), logger: quiet });
  await loader.loadAll();
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER });
  // No defaultOwnerJid → the whitelist is genuinely empty.
  const dispatcher = new Dispatcher({ plugins: loader, config, logger: quiet });

  assert.equal(dispatcher.isOwner(OWNER), false, 'an empty whitelist must trust nobody');
  await dispatcher.handle(socket, normalize(rawMessage('.secret', { jid: OWNER })));
  assert.equal(socket.outbox.length, 0);
});

// ══════════════════════════════════════════════════════════════════
test('config: refuses live mode without an owner whitelist', () => {
  const config = rig({ mode: 'live', ownerJids: [] });
  config.telegram.token = 'x';
  config.telegram.ownerId = '1';
  const { problems } = validateConfig(config);
  assert.ok(problems.some((p) => /OWNER_JIDS/.test(p)));
});

test('config: refuses live mode without a Telegram panel', () => {
  const config = rig({ mode: 'live', ownerJids: [OWNER] });
  config.telegram.token = '';
  config.telegram.ownerId = '';
  const { problems } = validateConfig(config);
  assert.ok(problems.some((p) => /Telegram panel/.test(p)));
});

test('config: an unknown mode degrades to dry-run, never to live', () => {
  const config = buildConfig({ mode: 'yolo' });
  assert.equal(config.mode, 'dry-run');
  assert.equal(config.risk, 0);
});

test('config: outbound loop-breaker bounds cannot be disabled or stretched indefinitely', () => {
  const names = ['OUTBOUND_LOOP_THRESHOLD', 'OUTBOUND_LOOP_WINDOW_MS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.OUTBOUND_LOOP_THRESHOLD = '1';
    process.env.OUTBOUND_LOOP_WINDOW_MS = '0';
    let config = buildConfig({ mode: 'dry-run' });
    assert.equal(config.safety.outboundLoopThreshold, 2);
    assert.equal(config.safety.outboundLoopWindowMs, 1_000);

    process.env.OUTBOUND_LOOP_THRESHOLD = '999';
    process.env.OUTBOUND_LOOP_WINDOW_MS = '999999999';
    config = buildConfig({ mode: 'dry-run' });
    assert.equal(config.safety.outboundLoopThreshold, 25);
    assert.equal(config.safety.outboundLoopWindowMs, 3_600_000);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

// ══════════════════════════════════════════════════════════════════
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

test('end-to-end: the real entry point runs .ping under dry-run', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--dry-run'], {
    input: '.ping\n/stats\n/out\n/quit\n',
    encoding: 'utf8',
    timeout: 30000,
    // E2E tests must not depend on a free port; the dashboard has its own
    // coverage in step2.test.js.
    env: { ...process.env, DASHBOARD_ENABLED: 'false' },
  });
  const out = stripAnsi(res.stdout);

  assert.equal(res.status, 0, `entry point exited ${res.status}\n${res.stderr}`);
  assert.match(out, /Nexus-WA/);
  assert.match(out, /ban risk: NONE/, 'banner must state there is no ban risk');
  assert.match(out, /Pong/, '.ping must reply through the fake socket');
  assert.match(out, /0 real WhatsApp calls/, 'must confirm no network transport was used');
  assert.match(out, /"kind": "text"/, '/out must show the recorded outbox');
  assert.match(out, /"handled": 1/, 'dispatcher must report exactly one handled command');
});

test('end-to-end: the harness lists loaded plugins', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--dry-run'], {
    input: '/list\n/quit\n',
    encoding: 'utf8',
    timeout: 30000,
    // E2E tests must not depend on a free port; the dashboard has its own
    // coverage in step2.test.js.
    env: { ...process.env, DASHBOARD_ENABLED: 'false' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(stripAnsi(res.stdout), /\.ping/);
});

test('end-to-end: a public command still answers a stranger (no over-blocking)', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--dry-run'], {
    input: '/as 15550002222@s.whatsapp.net .ping\n/quit\n',
    encoding: 'utf8',
    timeout: 30000,
    // E2E tests must not depend on a free port; the dashboard has its own
    // coverage in step2.test.js.
    env: { ...process.env, DASHBOARD_ENABLED: 'false' },
  });
  const out = stripAnsi(res.stdout);
  assert.equal(res.status, 0, res.stderr);
  // .ping is ownerOnly:false, so the gate must NOT swallow it.
  assert.match(out, /Pong/);
  assert.match(out, /you: `guest`/, 'a stranger must not be misidentified as the owner');
});

test('end-to-end: --list-plugins introspects without opening a transport', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--list-plugins'], {
    encoding: 'utf8',
    timeout: 30000,
    // E2E tests must not depend on a free port; the dashboard has its own
    // coverage in step2.test.js.
    env: { ...process.env, DASHBOARD_ENABLED: 'false' },
  });
  const out = stripAnsi(res.stdout);
  assert.equal(res.status, 0, res.stderr);
  assert.match(out, /\.ping/, 'must list the ping command');
  assert.doesNotMatch(out, /fake socket "connected"/, 'must not start any transport');
});

// ══════════════════════════════════════════════════════════════════
// Regression guards for bugs the harness itself once had.
// ══════════════════════════════════════════════════════════════════
test('mockSocket: an injected stranger normalises to the stranger, not the owner', async () => {
  const socket = new MockWhatsAppSocket({ logger: quiet });
  const seen = [];
  socket.on('messages.upsert', ({ messages }) => seen.push(normalize(messages[0])));

  await socket.inject('.ping', { from: STRANGER, pushName: 'Stranger' });

  assert.equal(seen[0].sender, STRANGER, 'the DM JID must be the stranger, or the owner gate is fake');
  assert.notEqual(seen[0].sender, OWNER);
  assert.equal(seen[0].isGroup, false);
  assert.equal(seen[0].jid, STRANGER, 'in a DM the chat JID is the other party');
});

test('mockSocket: an injected group message keeps group JID and real sender', async () => {
  const socket = new MockWhatsAppSocket({ logger: quiet });
  const seen = [];
  socket.on('messages.upsert', ({ messages }) => seen.push(normalize(messages[0])));

  await socket.injectGroup('.ping', { pushName: 'Stranger' });

  assert.equal(seen[0].jid, MOCK_GROUP_JID);
  assert.equal(seen[0].isGroup, true);
  assert.notEqual(seen[0].sender, MOCK_GROUP_JID, 'sender must never collapse to the group JID');
});

test('mockSocket: the outbox records what the bot "sent"', async () => {
  const socket = new MockWhatsAppSocket({ logger: quiet });
  await socket.connect();
  await socket.sendMessage(OWNER, { text: 'hello' });
  assert.equal(socket.outbox.length, 1);
  assert.equal(socket.outbox[0].kind, 'text');
  assert.equal(socket.outbox[0].text, 'hello');
});

test('end-to-end: /as targets the given JID and still runs the command', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--dry-run'], {
    input: `/as ${STRANGER} .ping\n/quit\n`,
    encoding: 'utf8',
    timeout: 30000,
    // E2E tests must not depend on a free port; the dashboard has its own
    // coverage in step2.test.js.
    env: { ...process.env, DASHBOARD_ENABLED: 'false' },
  });
  const out = stripAnsi(res.stdout);
  assert.equal(res.status, 0, res.stderr);
  assert.match(out, /Pong/, 'the injected command must actually execute');
  assert.match(out, /you: `guest`/, 'an injected stranger must not be treated as the owner');
  assert.doesNotMatch(out, /you: `owner`/);
});
