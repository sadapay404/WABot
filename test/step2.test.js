/**
 * Nexus-WA — Step 2 tests: storage, identity, anti-delete, pacing, dashboard.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryDb, getSetting, setSetting } from '../src/database/index.js';
import { buildConfig } from '../src/config/index.js';
import { createLogger } from '../src/core/logger.js';
import { LogBuffer } from '../src/core/logBuffer.js';
import {
  normalizeJid,
  jidToPhone,
  phoneToJid,
  isSelfJid,
  isGroupJid,
  resolvePhone,
  describeChat,
} from '../src/core/jid.js';
import { SessionRegistry } from '../src/core/sessionRegistry.js';
import { ContactStore } from '../src/core/contactStore.js';
import { MessageCache } from '../src/core/messageCache.js';
import { AntiDelete, extractRevoke, formatDeletion } from '../src/core/antiDelete.js';
import { OutboundQueue } from '../src/core/outboundQueue.js';
import { classifyDisconnect, backoffDelay, shouldRequestPairingCode, connectionBrowser, formatPairingCode } from '../src/core/whatsapp.js';
import { MockWhatsAppSocket } from '../src/core/mockSocket.js';
import { Dashboard, buildState, flagFor } from '../src/web/dashboard.js';
import { seedDemoData } from '../src/lib/demoSeed.js';
import { formatUptime, timeAgo, formatBytes } from '../src/lib/format.js';

const quiet = createLogger('fatal');
const SELF = '15550009999@s.whatsapp.net';
const MOM = '12025550188@s.whatsapp.net';

function rigConfig(over = {}) {
  const c = buildConfig({ mode: 'dry-run' });
  c.safety.rateLimitWindowMs = 250;
  c.safety.typingIndicator = false;
  c.telegram.token = '';
  c.telegram.ownerId = '';
  return Object.assign(c, over);
}

// ══════════════════════════════════════════════════════════════════
test('database: opens with the built-in driver and creates the schema', async () => {
  const db = await getMemoryDb();
  assert.equal(db.driver, 'node:sqlite');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of ['sessions', 'contacts', 'message_cache', 'deleted_messages', 'settings', 'connection_events']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('database: settings round-trip and default', async () => {
  const db = await getMemoryDb();
  assert.equal(getSetting(db, 'nope', 'fallback'), 'fallback');
  setSetting(db, 'nope', 'value');
  assert.equal(getSetting(db, 'nope', 'fallback'), 'value');
  setSetting(db, 'nope', 'updated');
  assert.equal(getSetting(db, 'nope'), 'updated', 'upsert must overwrite');
});

// ══════════════════════════════════════════════════════════════════
test('jid: normalises, extracts and rebuilds', () => {
  assert.equal(normalizeJid('12025550188:12@s.whatsapp.net'), '12025550188@s.whatsapp.net');
  assert.equal(jidToPhone('12025550188@s.whatsapp.net'), '12025550188');
  assert.equal(jidToPhone('120363000000000000@g.us'), '', 'a group has no phone number');
  assert.equal(phoneToJid('+1 (202) 555-0188'), '12025550188@s.whatsapp.net');
  assert.equal(isGroupJid('120363000000000000@g.us'), true);
  assert.equal(isSelfJid('12025550188:7@s.whatsapp.net', '12025550188@s.whatsapp.net'), true);
  assert.equal(isSelfJid(MOM, SELF), false);
});

test('jid: resolves a real number to a country', () => {
  const p = resolvePhone('923001234567');
  assert.equal(p.countryIso, 'PK');
  assert.equal(p.countryName, 'Pakistan');
  assert.equal(p.valid, true);
});

test('jid: an invalid range degrades instead of throwing', () => {
  const p = resolvePhone('15551234567'); // fictional 555 exchange
  assert.equal(p.valid, false);
  assert.equal(p.countryIso, null);
  assert.equal(p.countryName, null);
  assert.equal(resolvePhone('').digits, '');
  assert.equal(resolvePhone('120363000000000000@g.us').digits, '', 'groups have no phone');
});

test('jid: describeChat labels your own chat as You', () => {
  assert.equal(describeChat(SELF, { myJid: SELF }), 'You');
  assert.equal(describeChat(MOM, { myJid: SELF, name: 'Mom' }), 'Mom');
  assert.match(describeChat('120363000000000000@g.us', { myJid: SELF }), /^group /);
});

// ══════════════════════════════════════════════════════════════════
test('registry: records a session with country, and counts reconnects', async () => {
  const db = await getMemoryDb();
  const reg = new SessionRegistry(db, quiet);

  const first = reg.upsert({ jid: '923001234567@s.whatsapp.net', role: 'burner' });
  assert.equal(first.country_iso, 'PK');
  assert.equal(first.country_name, 'Pakistan');
  assert.equal(first.connect_count, 1);
  assert.equal(first.role, 'burner');

  const second = reg.upsert({ jid: '923001234567@s.whatsapp.net', role: 'burner' });
  assert.equal(second.connect_count, 2, 'a reconnect must increment, not duplicate');
  assert.equal(reg.list().length, 1, 'same number must not create a second row');
});

test('registry: status transitions and summary', async () => {
  const db = await getMemoryDb();
  const reg = new SessionRegistry(db, quiet);
  reg.upsert({ jid: '12025550123@s.whatsapp.net', role: 'primary' });
  reg.upsert({ jid: '971501234567@s.whatsapp.net', role: 'burner' });
  reg.setStatus('971501234567@s.whatsapp.net', 'banned', 'rate-limit test');

  const s = reg.summary();
  assert.equal(s.total, 2);
  assert.equal(s.active, 1);
  assert.equal(s.banned, 1);
  assert.equal(s.countries.includes('Pakistan'), false);
  assert.ok(s.countries.includes('United Arab Emirates'));
  assert.equal(reg.events('971501234567@s.whatsapp.net').some((e) => e.kind === 'status:banned'), true);
});

// ══════════════════════════════════════════════════════════════════
test('contacts: your saved name wins over their push name', async () => {
  const db = await getMemoryDb();
  const cs = new ContactStore(db, quiet);
  cs.upsert({ id: MOM, name: 'Mom', notify: 'Sarah 🌸' });

  assert.equal(cs.displayName(MOM).name, 'Mom');
  assert.equal(cs.displayName(MOM).source, 'local');
  const p = cs.profile(MOM);
  assert.equal(p.localName, 'Mom');
  assert.equal(p.notifyName, 'Sarah 🌸');
  assert.equal(p.countryIso, 'US');
});

test('contacts: falls back through verified → notify → phone → jid', async () => {
  const db = await getMemoryDb();
  const cs = new ContactStore(db, quiet);

  cs.upsert({ id: '4915112345678@s.whatsapp.net', notify: 'Jonas' });
  assert.equal(cs.displayName('4915112345678@s.whatsapp.net').source, 'notify');

  assert.equal(cs.displayName('61412345678@s.whatsapp.net').name, '+61412345678');
  assert.equal(cs.displayName('61412345678@s.whatsapp.net').source, 'phone');

  assert.equal(cs.displayName('120363000000000000@g.us').source, 'jid');
});

// ══════════════════════════════════════════════════════════════════
function rawMsg(id, text, { jid = MOM, sender = MOM } = {}) {
  return {
    key: { remoteJid: jid, fromMe: false, id, participant: undefined },
    pushName: 'Sarah',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text },
  };
}
function normMsg(id, text, opts = {}) {
  return {
    id,
    jid: opts.jid || MOM,
    sender: opts.sender || MOM,
    isGroup: false,
    isBot: false,
    text,
    media: opts.media || null,
    quoted: null,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

test('cache: stores text durably and keeps the raw object for media', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  const raw = rawMsg('S1', 'secret plans');
  cache.store(raw, normMsg('S1', 'secret plans'), SELF);

  const r = cache.resolveDeleted('S1');
  assert.equal(r.known, true);
  assert.equal(r.record.text, 'secret plans');
  assert.equal(r.raw, raw);
  assert.equal(r.mediaAvailable, false, 'a text message has no media to forward');
});

test('cache: media is flagged as forwardable', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  cache.store(
    rawMsg('S2', ''),
    normMsg('S2', '', {
      media: { type: 'image', key: 'imageMessage', mimetype: 'image/jpeg', payload: { fileLength: 1234 } },
    }),
    SELF
  );
  const r = cache.resolveDeleted('S2');
  assert.equal(r.record.has_media, 1);
  assert.equal(r.record.kind, 'image');
  assert.equal(r.mediaAvailable, true);
});

test('cache: evicts the raw tier past maxRaw, keeps the durable tier', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet, { maxRaw: 2 });
  for (const id of ['A', 'B', 'C']) cache.store(rawMsg(id, `t${id}`), normMsg(id, `t${id}`), SELF);

  assert.equal(cache.size().raw, 2, 'raw tier must respect maxRaw');
  assert.equal(cache.size().rows, 3, 'durable tier keeps everything');
  assert.equal(cache.getRaw('A'), null, 'oldest raw entry evicted');
  assert.equal(cache.getRecord('A').text, 'tA', '…but its text survives');
});

test('cache: prune removes expired rows', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet, { ttlMs: 1000 });
  cache.store(rawMsg('OLD', 'old'), normMsg('OLD', 'old'), SELF);
  const removed = cache.prune(Date.now() + 10_000);
  assert.equal(removed, 1);
  assert.equal(cache.size().rows, 0);
});

test('cache: an unknown stanza id resolves to known:false', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  const r = cache.resolveDeleted('NEVER_SEEN');
  assert.equal(r.known, false);
  assert.equal(r.record, null);
  assert.equal(r.raw, null);
});

// ══════════════════════════════════════════════════════════════════
test('extractRevoke: messages.update protocolMessage shape', () => {
  const id = extractRevoke({
    key: { remoteJid: MOM, id: 'REVOKE1' },
    update: { message: { protocolMessage: { type: 0, stanzaId: 'TARGET' } } },
  });
  assert.equal(id, 'TARGET');
});

test('extractRevoke: messages.upsert protocolMessage shape', () => {
  const id = extractRevoke({
    key: { remoteJid: MOM, id: 'R2' },
    message: { protocolMessage: { type: 0, stanzaId: 'TARGET2' } },
  });
  assert.equal(id, 'TARGET2');
});

test('extractRevoke: stub-type revoke (group admin)', () => {
  const id = extractRevoke({ key: { remoteJid: '120363@g.us', id: 'STUB1' }, messageStubType: 'REVOKE' });
  assert.equal(id, 'STUB1');
});

test('extractRevoke: ignores non-revoke protocol messages', () => {
  assert.equal(
    extractRevoke({ update: { message: { protocolMessage: { type: 7, stanzaId: 'X' } } } }),
    null,
    'MESSAGE_EDIT (7) is not a deletion'
  );
  assert.equal(extractRevoke({ key: { remoteJid: MOM } }), null);
  assert.equal(extractRevoke({}), null);
});

test('formatDeletion: your exact spec — number, saved name, content', () => {
  const text = formatDeletion({
    known: true,
    isGroup: false,
    chatLabel: 'Mom',
    mediaAvailable: false,
    at: Date.UTC(2026, 0, 1, 14, 32),
    profile: { name: 'Mom', phoneE164: '+12025550188', localName: 'Mom', notifyName: 'Mom ❤️', countryName: 'United States of America', numberType: 'FIXED_LINE_OR_MOBILE' },
    record: { kind: 'text', text: 'sorry wrong chat', has_media: 0 },
  });

  assert.match(text, /Deleted message/);
  assert.match(text, /Mom/);
  assert.match(text, /\+12025550188/);
  assert.match(text, /> sorry wrong chat/, 'the deleted content must be quoted');
  assert.match(text, /United States of America/);
});

test('formatDeletion: media is labelled as voice note / photo', () => {
  const voice = formatDeletion({
    known: true, isGroup: false, mediaAvailable: true, at: Date.now(),
    profile: { name: 'Dan', phoneE164: '+447400123499' },
    record: { kind: 'audio', media_mimetype: 'audio/ogg; codecs=opus', has_media: 1 },
  });
  assert.match(voice, /Deleted voice note/);

  const photo = formatDeletion({
    known: true, isGroup: false, mediaAvailable: true, at: Date.now(),
    profile: { name: 'Dan', phoneE164: '+447400123499' },
    record: { kind: 'image', media_mimetype: 'image/jpeg', has_media: 1 },
  });
  assert.match(photo, /Deleted photo/);
  assert.match(photo, /Forwarding the photo below/);
});

test('formatDeletion: says so honestly when content was never captured', () => {
  const text = formatDeletion({
    known: false, isGroup: false, mediaAvailable: false, at: Date.now(),
    profile: { name: '+61412345678', phoneE164: '+61412345678' },
    record: null,
  });
  assert.match(text, /Content not captured/);
});

// ── Full anti-delete flow over the real mock transport ────────────
async function antiDeleteRig() {
  const db = await getMemoryDb();
  const socket = new MockWhatsAppSocket({ logger: quiet, botJid: SELF });
  await socket.connect();
  const cache = new MessageCache(db, quiet);
  const contacts = new ContactStore(db, quiet);
  const registry = new SessionRegistry(db, quiet);
  const config = rigConfig();
  registry.upsert({ jid: SELF, role: 'primary' });
  contacts.upsert({ id: MOM, name: 'Mom', notify: 'Sarah 🌸' });

  const ad = new AntiDelete({ socket, db, cache, contacts, registry, logger: quiet, config });
  return { db, socket, cache, contacts, registry, ad, config };
}

test('anti-delete: end-to-end — message deleted, alert lands in your own chat', async () => {
  const { socket, ad } = await antiDeleteRig();

  const raw = rawMsg('DEL1', 'the code is 4417');
  ad.onMessage(raw, normMsg('DEL1', 'the code is 4417'));
  await ad.onUpdate({
    key: { remoteJid: MOM, fromMe: false, id: 'RV1' },
    update: { message: { protocolMessage: { type: 0, stanzaId: 'DEL1' } } },
  });

  assert.equal(ad.stats.detected, 1);
  assert.equal(ad.stats.resolved, 1);
  assert.equal(socket.outbox.length, 1, 'exactly one alert');

  const sent = socket.outbox[0];
  assert.equal(sent.jid, SELF, 'must go to the chat with yourself');
  assert.match(sent.text, /Mom/);
  assert.match(sent.text, /the code is 4417/);
});

test('anti-delete: forwards the actual deleted media', async () => {
  const { socket, ad } = await antiDeleteRig();
  const raw = rawMsg('DEL2', 'caption here');
  ad.onMessage(
    raw,
    normMsg('DEL2', 'caption here', {
      media: { type: 'image', key: 'imageMessage', mimetype: 'image/jpeg', payload: {} },
    })
  );

  let downloaded = 0;
  ad.downloader = async () => {
    downloaded++;
    return Buffer.from('fake-jpeg-bytes');
  };

  await ad.onUpdate({
    key: { remoteJid: MOM, fromMe: false, id: 'RV2' },
    update: { message: { protocolMessage: { type: 0, stanzaId: 'DEL2' } } },
  });

  assert.equal(downloaded, 1, 'the downloader must be invoked');
  assert.equal(ad.stats.mediaForwarded, 1);
  assert.equal(socket.outbox.length, 2, 'alert + the media itself');
  assert.equal(socket.outbox[1].kind, 'image');
});

test('anti-delete: media forwarding can be switched off', async () => {
  const { socket, ad } = await antiDeleteRig();
  ad.setForwardMedia(false);
  ad.onMessage(
    rawMsg('DEL3', ''),
    normMsg('DEL3', '', { media: { type: 'video', key: 'videoMessage', mimetype: 'video/mp4', payload: {} } })
  );
  await ad.onUpdate({
    key: { remoteJid: MOM, fromMe: false, id: 'RV3' },
    update: { message: { protocolMessage: { type: 0, stanzaId: 'DEL3' } } },
  });
  assert.equal(socket.outbox.length, 1, 'alert only, no media');
  assert.equal(ad.stats.mediaForwarded, 0);
});

test('anti-delete: a media failure never blocks the text alert', async () => {
  const { socket, ad } = await antiDeleteRig();
  ad.onMessage(
    rawMsg('DEL4', ''),
    normMsg('DEL4', '', { media: { type: 'image', key: 'imageMessage', mimetype: 'image/jpeg', payload: {} } })
  );
  ad.downloader = async () => {
    throw new Error('media expired server-side');
  };
  await ad.onUpdate({
    key: { remoteJid: MOM, fromMe: false, id: 'RV4' },
    update: { message: { protocolMessage: { type: 0, stanzaId: 'DEL4' } } },
  });
  assert.equal(socket.outbox.length, 1, 'the text alert must still arrive');
});

test('anti-delete: an uncached deletion still alerts, marked as unresolved', async () => {
  const { socket, ad } = await antiDeleteRig();
  await ad.onUpdate({
    key: { remoteJid: MOM, fromMe: false, id: 'RV5' },
    update: { message: { protocolMessage: { type: 0, stanzaId: 'NEVER_CACHED' } } },
  });
  assert.equal(ad.stats.unresolved, 1);
  assert.equal(socket.outbox.length, 1);
  assert.match(socket.outbox[0].text, /Content not captured/);
});

test('anti-delete: the toggle stops alerts entirely', async () => {
  const { socket, ad } = await antiDeleteRig();
  ad.setEnabled(false);
  await ad.onUpdate({
    key: { remoteJid: MOM, fromMe: false, id: 'RV6' },
    update: { message: { protocolMessage: { type: 0, stanzaId: 'X' } } },
  });
  assert.equal(ad.stats.detected, 0);
  assert.equal(socket.outbox.length, 0);
  ad.setEnabled(true);
  assert.equal(ad.enabled(), true);
});

test('anti-delete: deletions are persisted and listable', async () => {
  const { ad } = await antiDeleteRig();
  ad.onMessage(rawMsg('DEL7', 'persist me'), normMsg('DEL7', 'persist me'));
  await ad.onUpdate({
    key: { remoteJid: MOM, fromMe: false, id: 'RV7' },
    update: { message: { protocolMessage: { type: 0, stanzaId: 'DEL7' } } },
  });
  const rows = ad.recent(5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'persist me');
  assert.equal(rows[0].sender_name, 'Mom');
});

// ══════════════════════════════════════════════════════════════════
test('queue: serialises sends and records typing presence', async () => {
  const socket = new MockWebSocket();
  const config = rigConfig();
  config.safety.typingIndicator = true;
  const q = new OutboundQueue(socket, config, quiet);
  q.attach();

  await Promise.all([
    socket.sendMessage(MOM, { text: 'one' }),
    socket.sendMessage(MOM, { text: 'two' }),
  ]);

  assert.deepEqual(socket.sentOrder, ['one', 'two'], 'sends must complete in order');
  assert.ok(socket.signals.some((s) => s.presence === 'composing'), 'typing indicator shown');
  assert.ok(socket.signals.some((s) => s.presence === 'paused'), 'presence cleared afterwards');
  assert.equal(q.stats.sent, 2);
});

test('queue: holds sends past the per-chat budget instead of dropping them', async () => {
  const socket = new MockWebSocket();
  const config = rigConfig();
  config.safety.rateLimitPerMin = 2;
  config.safety.rateLimitWindowMs = 200;
  const q = new OutboundQueue(socket, config, quiet);
  q.attach();

  const t0 = Date.now();
  await socket.sendMessage(MOM, { text: 'a' });
  await socket.sendMessage(MOM, { text: 'b' });
  await socket.sendMessage(MOM, { text: 'c' }); // third inside the window → held
  const elapsed = Date.now() - t0;

  assert.equal(socket.sentOrder.length, 3, 'nothing is dropped');
  assert.ok(elapsed >= 150, `third send should have waited for the window (took ${elapsed}ms)`);
  assert.ok(q.stats.throttledMs > 0, 'throttle time must be recorded');
});

test('queue: a failing send rejects the caller rather than hanging', async () => {
  const socket = new MockWebSocket();
  socket.failNext = true;
  const config = rigConfig();
  new OutboundQueue(socket, config, quiet).attach();
  await assert.rejects(() => socket.sendMessage(MOM, { text: 'boom' }), /send exploded/);
});

// ══════════════════════════════════════════════════════════════════
test('classifyDisconnect: logged out means re-link, not retry', () => {
  assert.equal(classifyDisconnect(401), 'relogin');
  assert.equal(classifyDisconnect(515), 'restart');
  assert.equal(classifyDisconnect(408), 'restart');
  assert.equal(classifyDisconnect(403), 'relogin');
  assert.equal(classifyDisconnect(411), 'relogin');
  assert.equal(classifyDisconnect(undefined), 'backoff');
  assert.equal(classifyDisconnect(999), 'backoff');
});

test('classifyDisconnect: works against the real DisconnectReason object', async () => {
  const { DisconnectReason } = await import('@whiskeysockets/baileys');
  assert.equal(classifyDisconnect(DisconnectReason.loggedOut, DisconnectReason), 'relogin');
  assert.equal(classifyDisconnect(DisconnectReason.restartRequired, DisconnectReason), 'restart');
  assert.equal(classifyDisconnect(DisconnectReason.connectionLost, DisconnectReason), 'restart');
});

test('backoffDelay: grows, jitters and caps', () => {
  const d1 = backoffDelay(1, { baseMs: 1000, maxMs: 10000 });
  const d5 = backoffDelay(5, { baseMs: 1000, maxMs: 10000 });
  const d20 = backoffDelay(20, { baseMs: 1000, maxMs: 10000 });
  assert.ok(d1 <= 1000, `first delay should be <= base, got ${d1}`);
  assert.ok(d5 > d1, 'delay must grow');
  assert.ok(d20 <= 10000, `must cap at maxMs, got ${d20}`);
  assert.ok(backoffDelay(0, { baseMs: 1000, maxMs: 10000 }) >= 0, 'delay must never be negative');
});

test('pairing code: request on the first fresh QR, never wait for open', () => {
  const base = { qr: 'qr-payload', pairingNumber: '923001234567', registered: false };
  assert.equal(shouldRequestPairingCode(base), true);
  assert.equal(shouldRequestPairingCode({ ...base, requested: true }), false, 'only once per socket');
  assert.equal(shouldRequestPairingCode({ ...base, registered: true }), false, 'already linked session');
  assert.equal(shouldRequestPairingCode({ ...base, pairingNumber: '' }), false, 'QR fallback when no number');
  assert.equal(
    shouldRequestPairingCode({ ...base, qr: undefined }),
    false,
    'connection=open alone cannot request the first pairing code'
  );
});

test('pairing code: uses Baileys canonical platform instead of the Nexus app label', async () => {
  const { Browsers } = await import('@whiskeysockets/baileys');
  const config = buildConfig({ mode: 'dry-run' });
  assert.deepEqual(config.wa.browser, ['Ubuntu', 'Chrome', '22.04.4']);

  config.wa.pairingNumber = '923067607949';
  config.wa.browser = ['Nexus-WA', 'Nexus-WA/0.1.0', '1.0.0'];
  assert.deepEqual(connectionBrowser({ Browsers }, config), ['Ubuntu', 'Chrome', '22.04.4']);
});

test('pairing code: display groups four-character halves without altering the value', () => {
  assert.equal(formatPairingCode('ABCD1234'), 'ABCD-1234');
  assert.equal(formatPairingCode('ABCD'), 'ABCD');
  assert.equal(formatPairingCode(''), '');
});

// ══════════════════════════════════════════════════════════════════
test('flagFor: ISO code to flag, unknown to white flag', () => {
  assert.equal(flagFor('PK'), '🇵🇰');
  assert.equal(flagFor('pk'), '🇵🇰');
  assert.equal(flagFor(null), '🏳️');
  assert.equal(flagFor('XYZ'), '🏳️');
});

test('dashboard: buildState exposes sessions, countries and deletions', async () => {
  const db = await getMemoryDb();
  const registry = new SessionRegistry(db, quiet);
  const contacts = new ContactStore(db, quiet);
  const cache = new MessageCache(db, quiet);
  const config = rigConfig();
  const socket = new MockWhatsAppSocket({ logger: quiet, botJid: SELF });
  const antiDelete = new AntiDelete({ socket, db, cache, contacts, registry, logger: quiet, config });

  const n = seedDemoData({ db, registry, contacts, selfJid: SELF });
  assert.equal(n.sessions, 5);

  const state = buildState({
    config,
    registry,
    contacts,
    cache,
    antiDelete,
    plugins: { list: () => [], commands: new Map(), failures: [] },
    dispatcher: { stats: { handled: 0, rejected: 0, errors: 0 } },
    queue: { depth: () => ({}) },
    logs: { tail: () => [] },
  });

  assert.equal(state.synthetic, true, 'dry-run must be flagged synthetic');
  assert.equal(state.sessions.length, 5);
  assert.ok(state.countries.length >= 4, 'several countries should be represented');
  assert.ok(state.sessions.every((s) => s.country_name), 'every seeded session resolves a country');
  assert.ok(state.deletions.length >= 5);
  assert.ok(state.contacts.named.length >= 5);
});

test('dashboard: serves the UI and JSON over HTTP in dry-run', async () => {
  const db = await getMemoryDb();
  const registry = new SessionRegistry(db, quiet);
  const contacts = new ContactStore(db, quiet);
  const config = rigConfig();
  const socket = new MockWhatsAppSocket({ logger: quiet, botJid: SELF });
  const cache = new MessageCache(db, quiet);
  const antiDelete = new AntiDelete({ socket, db, cache, contacts, registry, logger: quiet, config });
  seedDemoData({ db, registry, contacts, selfJid: SELF });

  const dash = new Dashboard({
    app: {
      config, registry, contacts, cache, antiDelete,
      plugins: { list: () => [], commands: new Map(), failures: [] },
      dispatcher: { stats: {} }, queue: { depth: () => ({}) }, logs: { tail: () => [] },
    },
    config,
    logger: quiet,
    port: 0,
  });
  await dash.listen('127.0.0.1');

  try {
    const base = `http://127.0.0.1:${dash.port}`;
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /Nexus/);

    const api = await fetch(`${base}/api/state`);
    assert.equal(api.status, 200);
    const body = await api.json();
    assert.equal(body.sessions.length, 5);

    const health = await fetch(`${base}/healthz`);
    assert.equal((await health.json()).ok, true);

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await dash.stop();
  }
});

test('dashboard: refuses to start in a connected mode without a token', async () => {
  const config = rigConfig({ isDryRun: false, isLive: true, mode: 'live' });
  const dash = new Dashboard({ app: { config }, config, logger: quiet, port: 0 });
  await assert.rejects(() => dash.listen('127.0.0.1'), /DASHBOARD_TOKEN/);
});

test('dashboard: rejects an unauthorised request in a connected mode', async () => {
  process.env.DASHBOARD_TOKEN = 's3cret-token';
  const config = rigConfig({ isDryRun: false, isLive: true, mode: 'live' });
  const dash = new Dashboard({ app: { config }, config, logger: quiet, port: 0 });
  await dash.listen('127.0.0.1');
  try {
    const base = `http://127.0.0.1:${dash.port}`;
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state?token=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/api/state?token=s3cret-token`)).status, 200);
    // healthz stays open so the platform can probe liveness
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await dash.stop();
    delete process.env.DASHBOARD_TOKEN;
  }
});

// ══════════════════════════════════════════════════════════════════
test('logBuffer: captures lines from any child logger', () => {
  const buf = new LogBuffer(3).attach();
  const log = createLogger('info');
  log.info('first');
  log.child({ scope: 'plugins' }).warn('second');
  log.error('third');
  log.info('fourth');

  const tail = buf.tail(10);
  assert.equal(tail.length, 3, 'ring buffer must cap at max');
  assert.equal(tail.at(-1).message, 'fourth');
  assert.match(buf.text(), /fourth/);
  buf.detach();
});

test('format: uptime, timeAgo and bytes', () => {
  assert.equal(formatUptime(0), '0s');
  assert.equal(formatUptime(65), '1m 5s');
  assert.equal(formatUptime(3725), '1h 2m');
  assert.equal(formatUptime(90061), '1d 1h');
  assert.equal(timeAgo(Date.now() - 65000), '1m ago');
  assert.equal(formatBytes(1536), '1.5 KB');
});

// ══════════════════════════════════════════════════════════════════
/** Minimal socket stub that records call order, for queue tests. */
class MockWebSocket {
  constructor() {
    this.sentOrder = [];
    this.signals = [];
    this.failNext = false;
    this.user = { id: SELF };
  }
  async sendMessage(jid, content) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('send exploded');
    }
    // Yield so an unserialised implementation would interleave.
    await new Promise((r) => setTimeout(r, 5));
    this.sentOrder.push(content.text);
    return { key: { id: `X${this.sentOrder.length}` } };
  }
  async sendPresenceUpdate(presence, jid) {
    this.signals.push({ presence, jid });
  }
}
