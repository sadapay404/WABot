/**
 * Nexus-WA — Step 3 tests: scheduler, notes, triggers, webhooks, backups,
 * audit, the kill-switch, FTS search, view-once capture and edit tracking.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getMemoryDb } from '../src/database/index.js';
import { createLogger } from '../src/core/logger.js';
import { parseWhen } from '../src/lib/when.js';
import { Scheduler } from '../src/core/scheduler.js';
import { NoteStore } from '../src/core/notes.js';
import { Triggers } from '../src/core/triggers.js';
import { Webhooks } from '../src/core/webhooks.js';
import { AuditLog } from '../src/core/audit.js';
import { SessionBackup } from '../src/core/backup.js';
import { OutboundQueue } from '../src/core/outboundQueue.js';
import { MessageCache } from '../src/core/messageCache.js';
import { ContactStore } from '../src/core/contactStore.js';
import { MediaStore } from '../src/core/mediaStore.js';
import { EditWatch } from '../src/core/editWatch.js';
import { ViewOnceCapture } from '../src/core/viewOnce.js';
import { PluginLoader } from '../src/core/pluginLoader.js';
import { buildConfig } from '../src/config/index.js';
import { MockWhatsAppSocket } from '../src/core/mockSocket.js';

const quiet = createLogger('fatal');
const SELF = '15550009999@s.whatsapp.net';
const MOM = '12025550188@s.whatsapp.net';

/** Minimal send sink: records everything the bot would have sent. */
function fakeSocket() {
  const sent = [];
  return {
    sent,
    user: { id: SELF },
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: `SENT${sent.length}` } };
    },
    async sendPresenceUpdate() {},
    async readMessages() {},
    async downloadMediaMessage() {
      return Buffer.from('fake-bytes');
    },
  };
}

function rigConfig(over = {}) {
  const c = buildConfig({ mode: 'dry-run' });
  c.safety.rateLimitWindowMs = 5;
  c.safety.rateLimitPerMin = 10_000;
  c.safety.typingDelayMs = 0;
  return Object.assign(c, over);
}

// ── when.js: relative offsets ────────────────────────────────────────
test('when: parses spelled-out relative times, not just 10m', async () => {
  const now = 1_700_000_000_000;
  const cases = [
    ['in 1 minute', 60_000],
    ['in 20 minutes', 1_200_000],
    ['in 2 hours', 7_200_000],
    ['in 5 mins', 300_000],
    ['in 90 seconds', 90_000],
    ['in 3 days from now', 259_200_000],
    ['in 1 week', 604_800_000],
    ['20m', 1_200_000],
  ];
  for (const [text, want] of cases) {
    const r = parseWhen(text, now);
    assert.ok(r, `should parse "${text}"`);
    assert.equal(r.runAt - now, want, `offset for "${text}"`);
    assert.equal(r.kind, 'once');
  }
});

test('when: returns null rather than guessing', async () => {
  for (const bad of ['', 'sometime', 'later', 'in a while', 'next week-ish']) {
    assert.equal(parseWhen(bad, 1_700_000_000_000), null, `"${bad}" must not parse`);
  }
});

// ── scheduler ────────────────────────────────────────────────────────
test('scheduler: delivers a due job through the socket', async () => {
  const db = await getMemoryDb();
  const socket = fakeSocket();
  const s = new Scheduler({ db, socket, logger: quiet });
  const job = s.add({ jid: SELF, text: 'take the pills', runAt: 1000 });

  assert.equal(s.pending().length, 1);
  await s.tick(999);
  assert.equal(socket.sent.length, 0, 'not due yet');

  await s.tick(1000);
  assert.equal(socket.sent.length, 1);
  assert.match(socket.sent[0].content.text, /take the pills/);
  assert.equal(s.pending().length, 0);
  assert.equal(s.get(job.id).status, 'done');
});

test('scheduler: recurring jobs re-arm from run_at, so a late tick does not drift', async () => {
  const db = await getMemoryDb();
  const socket = fakeSocket();
  const s = new Scheduler({ db, socket, logger: quiet });
  s.add({ jid: SELF, text: 'stand up', runAt: 10_000, kind: 'recurring', intervalMs: 10_000 });

  await s.tick(10_000);
  assert.equal(socket.sent.length, 1);

  // The next tick is very late. It must arm for 20_000 (run_at + interval),
  // not for now + interval, or the schedule would slide later every time.
  const after = s.pending()[0];
  assert.equal(after.run_at, 20_000, `expected 20000, got ${after.run_at}`);

  // A single very late tick fires once and arms the next slot past now.
  await s.tick(45_000);
  assert.equal(socket.sent.length, 2, 'a backlog must not burst-fire');
  assert.ok(s.pending()[0].run_at > 45_000, 'next slot is in the future');
});

test('scheduler: a job interrupted by a crash is resumed, not lost', async () => {
  const db = await getMemoryDb();
  const s = new Scheduler({ db, socket: fakeSocket(), logger: quiet });
  const job = s.add({ jid: SELF, text: 'mid-flight', runAt: 1000 });
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id);

  const fresh = new Scheduler({ db, socket: fakeSocket(), logger: quiet });
  fresh.resumeOrphans();
  assert.equal(fresh.stats.resumed, 1);
  assert.equal(fresh.get(job.id).status, 'pending');
});

test('scheduler: a failing delivery stays pending and records why', async () => {
  const db = await getMemoryDb();
  const socket = {
    ...fakeSocket(),
    async sendMessage() {
      throw new Error('network down');
    },
  };
  const s = new Scheduler({ db, socket, logger: quiet });
  const job = s.add({ jid: SELF, text: 'will fail', runAt: 1000 });

  await s.tick(1000);
  assert.equal(s.stats.failed, 1);
  const row = s.get(job.id);
  assert.equal(row.status, 'pending', 'must retry, not silently vanish');
  assert.match(row.last_error, /network down/);
});

test('scheduler: maxPerTick caps a backlog so it cannot burst-spam', async () => {
  const db = await getMemoryDb();
  const socket = fakeSocket();
  const s = new Scheduler({ db, socket, logger: quiet, maxPerTick: 2 });
  for (let i = 0; i < 5; i++) s.add({ jid: SELF, text: `msg ${i}`, runAt: 1000 });

  await s.tick(1000);
  assert.equal(socket.sent.length, 2);
  assert.equal(s.pending().length, 3);
});

// ── notes ────────────────────────────────────────────────────────────
test('notes: notes and todos are separate kinds with their own summary', async () => {
  const db = await getMemoryDb();
  const n = new NoteStore(db, quiet);
  n.add('buy milk');
  n.add('fix the roof', { kind: 'todo' });

  assert.equal(n.summary().notes, 1);
  assert.equal(n.summary().todos, 1);
  assert.equal(n.list({ kind: 'todo' })[0].text, 'fix the roof');
  assert.equal(n.list({ kind: 'note' })[0].text, 'buy milk');
});

test('notes: completing a todo hides it from the open list', async () => {
  const db = await getMemoryDb();
  const n = new NoteStore(db, quiet);
  const t = n.add('fix the roof', { kind: 'todo' });
  n.complete(t.id);
  assert.equal(n.list({ kind: 'todo' }).length, 0);
  assert.equal(n.list({ kind: 'todo', includeDone: true }).length, 1);
  assert.equal(n.summary().done, 1);
});

test('notes: due reminders surface only once their time has passed', async () => {
  const db = await getMemoryDb();
  const n = new NoteStore(db, quiet);
  n.add('call mom', { kind: 'todo', remindAt: 5000 });
  assert.equal(n.dueReminders(4999).length, 0);
  assert.equal(n.dueReminders(5000).length, 1);
});

// ── triggers ─────────────────────────────────────────────────────────
test('triggers: off by default, because auto-replying to real people is a ban signal', async () => {
  const db = await getMemoryDb();
  const t = new Triggers({ db, logger: quiet });
  assert.equal(t.enabled(), false);
  t.add({ pattern: 'wifi', response: 'hunter22' });
  assert.equal(t.match({ text: 'what is the wifi', sender: MOM, jid: MOM }), null);
});

test('triggers: match once enabled, then cool down per chat', async () => {
  const db = await getMemoryDb();
  const t = new Triggers({ db, logger: quiet, cooldownMs: 90_000 });
  t.setEnabled(true);
  t.add({ pattern: 'wifi', response: 'hunter22' });

  const first = t.match({ text: 'what is the wifi', sender: MOM, jid: MOM, fromMe: false });
  assert.ok(first, 'should match when enabled');
  assert.match(first.response, /hunter22/);

  const second = t.match({ text: 'wifi again?', sender: MOM, jid: MOM, fromMe: false });
  assert.equal(second, null, 'cooldown must suppress the immediate repeat');
});

test('triggers: never answer the bot itself or a commands request', async () => {
  const db = await getMemoryDb();
  const t = new Triggers({ db, logger: quiet, cooldownMs: 0 });
  t.setEnabled(true);
  t.add({ pattern: 'wifi', response: 'hunter22' });

  // isBot is what normalize() derives from key.fromMe.
  assert.equal(t.match({ text: 'wifi', sender: SELF, jid: MOM, isBot: true }), null);
  assert.equal(t.match({ text: '.commands wifi', sender: MOM, jid: MOM, isBot: false }), null);
});

// ── webhooks ─────────────────────────────────────────────────────────
test('webhooks: nothing is sent until the owner adds a URL', async () => {
  const db = await getMemoryDb();
  const calls = [];
  const w = new Webhooks({ db, logger: quiet, fetchImpl: async (...a) => (calls.push(a), { ok: true, status: 200 }) });
  await w.emit('delete', { from: MOM });
  assert.equal(calls.length, 0);
});

test('webhooks: filters by subscribed event', async () => {
  const db = await getMemoryDb();
  const calls = [];
  const w = new Webhooks({ db, logger: quiet, fetchImpl: async (...a) => (calls.push(a), { ok: true, status: 200 }) });
  w.add({ url: 'https://example.test/hook', events: 'delete' });
  await w.emit('edit', { from: MOM });
  assert.equal(calls.length, 0, 'not subscribed to edits');
  await w.emit('delete', { from: MOM });
  assert.equal(calls.length, 1);
});

test('webhooks: a secret produces a verifiable HMAC over the exact body', async () => {
  const db = await getMemoryDb();
  let captured = null;
  const w = new Webhooks({
    db, logger: quiet,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200 };
    },
  });
  w.add({ url: 'https://example.test/hook', events: '*', secret: 's3cret' });
  await w.emit('delete', { from: MOM });

  const sig = captured.init.headers['x-nexus-signature'];
  assert.ok(sig, 'signature header must be present');
  const expected = crypto.createHmac('sha256', 's3cret').update(captured.init.body).digest('hex');
  assert.equal(sig, expected, 'signature must cover the exact bytes sent');
});

test('webhooks: a failing endpoint is recorded, not retried in a loop', async () => {
  const db = await getMemoryDb();
  const w = new Webhooks({
    db, logger: quiet,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const hook = w.add({ url: 'https://example.test/hook', events: '*' });
  await w.emit('delete', { from: MOM });
  const row = w.get(hook.id);
  assert.equal(row.fail_count, 1);
  assert.match(row.last_error, /ECONNREFUSED/);
});

// ── backups ──────────────────────────────────────────────────────────
test('backup: round-trips session and database under one passphrase', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nwb-'));
  const sessionDir = path.join(tmp, 'auth');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'creds.json'), '{"noiseKey":"abc"}');
  const dbPath = path.join(tmp, 'nexus.db');
  fs.writeFileSync(dbPath, 'fake-db-bytes');

  const b = new SessionBackup({ logger: quiet, sessionDir, dbPath, dir: path.join(tmp, 'backups') });
  const made = b.create('correct horse battery');
  assert.ok(made.file && made.bytes > 0, 'backup written');
  const file = made.file;
  assert.ok(fs.existsSync(file), 'backup file exists');

  // The blob must not contain the plaintext credentials.
  const blob = fs.readFileSync(file);
  assert.equal(blob.subarray(0, 6).toString(), 'NEXWA1', 'magic header');
  assert.ok(!blob.includes(Buffer.from('noiseKey')), 'plaintext must not appear in the blob');

  // Wipe, then restore.
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.writeFileSync(dbPath, '');
  b.restore(file, 'correct horse battery');
  assert.equal(fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8'), '{"noiseKey":"abc"}');
  assert.equal(fs.readFileSync(dbPath, 'utf8'), 'fake-db-bytes');
});

test('backup: a wrong passphrase fails without revealing which half was wrong', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nwb-'));
  const sessionDir = path.join(tmp, 'auth');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'creds.json'), '{"noiseKey":"abc"}');
  const dbPath = path.join(tmp, 'nexus.db');
  fs.writeFileSync(dbPath, 'fake-db-bytes');

  const b = new SessionBackup({ logger: quiet, sessionDir, dbPath, dir: path.join(tmp, 'backups') });
  const file = b.create('correct horse battery').file;

  assert.throws(() => b.restore(file, 'wrong passphrase'), /decrypt|authenticat|corrupt|passphrase/i);
});

test('backup: refuses a passphrase too short to resist brute force', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nwb-'));
  const b = new SessionBackup({
    logger: quiet,
    sessionDir: path.join(tmp, 'auth'),
    dbPath: path.join(tmp, 'nexus.db'),
    dir: path.join(tmp, 'backups'),
  });
  assert.throws(() => b.create('short'), /8|passphrase/i);
});

// ── audit ────────────────────────────────────────────────────────────
test('audit: records who did what, newest first', async () => {
  const db = await getMemoryDb();
  const a = new AuditLog(db, quiet);
  a.record({ action: 'panic-halt', actorJid: SELF, plugin: 'panic' });
  a.record({ action: 'webhook-add', actorJid: SELF, plugin: 'webhook', detail: 'https://x' });

  assert.equal(a.count(), 2);
  assert.equal(a.recent()[0].action, 'webhook-add');
  assert.match(a.text(), /panic-halt/);
});

test('audit: prune drops only entries older than the window', async () => {
  const db = await getMemoryDb();
  const a = new AuditLog(db, quiet);
  a.record({ action: 'old', actorJid: SELF });
  db.prepare('UPDATE audit SET ts = ts - ?').run(200 * 86_400_000);
  a.record({ action: 'new', actorJid: SELF });

  a.prune(90 * 86_400_000);
  const left = a.recent().map((r) => r.action);
  assert.deepEqual(left, ['new']);
});

// ── kill-switch ──────────────────────────────────────────────────────
test('kill-switch: halt drops the queue and refuses new sends', async () => {
  const socket = fakeSocket();
  const q = new OutboundQueue(socket, rigConfig(), quiet);
  q.attach();

  const dropped = q.halt();
  assert.equal(typeof dropped, 'number');
  await assert.rejects(socket.sendMessage(SELF, { text: 'hello' }), /halted/);
  assert.equal(q.depth().halted, true);
});

test('kill-switch: allowOnce lets exactly one confirmation through', async () => {
  const socket = fakeSocket();
  const q = new OutboundQueue(socket, rigConfig(), quiet);
  q.attach();
  q.halt();
  q.allowOnce();

  await socket.sendMessage(SELF, { text: 'outbound halted' });
  assert.equal(socket.sent.length, 1, 'the confirmation must get through');
  await assert.rejects(socket.sendMessage(SELF, { text: 'second' }), /halted/);
  assert.equal(socket.sent.length, 1, 'only one message escapes');
});

test('kill-switch: resume clears the pass and lets normal traffic through', async () => {
  const socket = fakeSocket();
  const q = new OutboundQueue(socket, rigConfig(), quiet);
  q.attach();
  q.halt();
  q.allowOnce();
  q.resume();
  assert.equal(q.escape, 0, 'resume must not leave a stale pass around');

  await socket.sendMessage(SELF, { text: 'back to normal' });
  await socket.sendMessage(SELF, { text: 'and again' });
  assert.equal(socket.sent.length, 2);
});

// ── FTS ──────────────────────────────────────────────────────────────
test('search: the FTS index is readable, not just indexable', async () => {
  // Regression: an external-content FTS5 table whose columns do not match the
  // content table indexes fine and MATCH works, but reading any column value
  // fails with "no such column: T.sender". Probe by reading, not by counting.
  const db = await getMemoryDb();
  assert.equal(db.fts, true, 'fts5 must be available in this build');
  const cache = new MessageCache(db, quiet);
  cache.store({ key: { remoteJid: MOM, fromMe: false, id: 'X1' } }, {
    id: 'X1', jid: MOM, sender: MOM, kind: 'text', isBot: false,
    text: 'the wifi password is hunter22', timestamp: Math.floor(Date.now() / 1000),
  }, SELF);

  // Would throw if the column shape were wrong again.
  const hit = db
    .prepare("SELECT rowid, text FROM message_fts WHERE message_fts MATCH '\"wifi\"' LIMIT 1")
    .get();
  assert.ok(hit, 'expected an FTS hit');
  assert.match(hit.text, /wifi/);
});

test('search: FTS rows track updates and deletes via triggers', async () => {
  const db = await getMemoryDb();
  const cache = new MessageCache(db, quiet);
  const ts = Math.floor(Date.now() / 1000);
  const rawA = { key: { remoteJid: MOM, fromMe: false, id: 'X2' } };
  cache.store(rawA, { id: 'X2', jid: MOM, sender: MOM, kind: 'text', isBot: false, text: 'alpha bravo', timestamp: ts }, SELF);
  assert.ok(db.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH '\"alpha\"'").get());

  cache.store(rawA, { id: 'X2', jid: MOM, sender: MOM, kind: 'text', isBot: false, text: 'charlie delta', timestamp: ts }, SELF);
  assert.equal(
    db.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH '\"alpha\"'").get(),
    undefined,
    'the stale term must leave the index on update'
  );
  assert.ok(db.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH '\"charlie\"'").get());
});

// ── plugin loader ────────────────────────────────────────────────────
test('pluginLoader: accepts a multi-command module and honours per-command gates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nwb-plugins-'));
  fs.writeFileSync(
    path.join(dir, 'multi.js'),
    `export default {
       category: 'tools',
       ownerOnly: true,
       commands: [
         { name: 'alpha', description: 'a', usage: '.alpha', execute: async () => {} },
         { name: 'beta', description: 'b', usage: '.beta', ownerOnly: false,
           aliases: ['b'], execute: async () => {} },
       ],
     };`
  );

  const loader = new PluginLoader({ dir, logger: quiet });
  await loader.loadAll();
  assert.deepEqual(loader.failures, [], 'no load failures');
  assert.ok(loader.commands.has('alpha'));
  assert.ok(loader.commands.has('beta'));
  assert.equal(loader.commands.get('alpha').ownerOnly, true, 'inherits the group default');
  assert.equal(loader.commands.get('beta').ownerOnly, false, 'per-command override wins');
  assert.equal(loader.aliases.get('b'), 'beta', 'alias maps to its command');
  assert.equal(loader.resolve('b').name, 'beta', 'resolve() follows aliases');
  assert.equal(loader.commands.get('beta').category, 'tools');
});

test('pluginLoader: a throwing plugin is reported, not fatal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nwb-plugins-'));
  fs.writeFileSync(path.join(dir, 'broken.js'), 'throw new Error("boom");');
  fs.writeFileSync(
    path.join(dir, 'fine.js'),
    'export default { name: "fine", description: "d", usage: ".fine", execute: async () => {} };'
  );

  const loader = new PluginLoader({ dir, logger: quiet });
  await loader.loadAll();
  assert.ok(loader.commands.has('fine'), 'the good plugin still loads');
  assert.equal(loader.failures.length, 1);
  assert.match(loader.failures[0].error, /boom/);
});

// ── edit tracking ────────────────────────────────────────────────────
test('edits: a rewritten message is stored with both versions', async () => {
  const db = await getMemoryDb();
  const socket = fakeSocket();
  const cache = new MessageCache(db, quiet);
  const contacts = new ContactStore(db, quiet);
  contacts.upsertMany([{ id: MOM, name: 'Mom', notify: 'Mom' }]);
  const watch = new EditWatch({ socket, db, cache, contacts, logger: quiet, config: rigConfig() });

  const sent = {
    key: { remoteJid: MOM, fromMe: false, id: 'STANZA1' },
    pushName: 'Mom',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: 'I hate Mondays' },
  };
  const { normalize } = await import('../src/core/message.js');
  // EditWatch recovers the original from the message cache, which inbound
  // messages populate — so store it there, exactly as the running bot does.
  cache.store(sent, normalize(sent), SELF);

  const update = {
    key: { remoteJid: MOM, fromMe: false, id: 'UPDATE1', participant: undefined },
    update: {
      message: {
        protocolMessage: {
          type: 14,
          stanzaId: 'STANZA1',
          editedMessage: { conversation: 'I love Mondays' },
        },
      },
    },
  };
  const result = await watch.onUpdate(update);

  assert.ok(result, 'edit should be reported');
  const row = db.prepare('SELECT * FROM message_edits WHERE stanza_id = ?').get('STANZA1');
  assert.ok(row, 'edit persisted');
  assert.equal(row.before_text, 'I hate Mondays');
  assert.equal(row.after_text, 'I love Mondays');
  assert.ok(socket.sent.length >= 1, 'the owner is alerted');
  assert.match(socket.sent.at(-1).content.text, /I love Mondays/);
});

// ── view-once capture ────────────────────────────────────────────────
test('view-once: captured, archived and forwarded to the self-chat', async () => {
  const db = await getMemoryDb();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nwb-media-'));
  const socket = fakeSocket();
  const contacts = new ContactStore(db, quiet);
  contacts.upsertMany([{ id: MOM, name: 'Mom', notify: 'Mom' }]);
  const media = new MediaStore({ db, logger: quiet, dir: tmp });

  const capture = new ViewOnceCapture({
    socket, db, contacts, registry: null, mediaStore: media, logger: quiet, config: rigConfig(),
  });

  const raw = {
    key: { remoteJid: MOM, fromMe: false, id: 'VO1' },
    pushName: 'Mom',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      viewOnceMessageV2: {
        message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 10, caption: 'secret' } },
      },
    },
  };
  const { normalize } = await import('../src/core/message.js');
  const msg = normalize(raw);
  assert.equal(msg.viewOnce, true, 'the normaliser must see through the envelope');

  const result = await capture.onMessage(raw, msg);
  assert.ok(result, 'capture should report a result');

  const row = db.prepare('SELECT * FROM view_once WHERE stanza_id = ?').get('VO1');
  assert.ok(row, 'view-once row persisted');
  assert.equal(row.sender_jid, MOM);

  const alert = socket.sent.find((s) => /View-once/i.test(s.content.text || ''));
  assert.ok(alert, 'an alert must reach the self-chat');
  assert.equal(alert.jid, SELF, 'forwarded to the owner, not the sender');
  assert.match(alert.content.text, /Mom/);
});

test('view-once: an empty payload is recorded, never silently dropped', async () => {
  const db = await getMemoryDb();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nwb-media-'));
  const socket = fakeSocket();
  const media = new MediaStore({ db, logger: quiet, dir: tmp });
  const capture = new ViewOnceCapture({
    socket, db, contacts: new ContactStore(db, quiet), registry: null,
    mediaStore: media, logger: quiet, config: rigConfig(),
  });

  const raw = {
    key: { remoteJid: MOM, fromMe: false, id: 'VO2' },
    pushName: 'Mom',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { viewOnceMessageV2: { message: {} } },
  };
  const { normalize } = await import('../src/core/message.js');
  await capture.onMessage(raw, normalize(raw));

  const row = db.prepare('SELECT * FROM view_once WHERE stanza_id = ?').get('VO2');
  assert.ok(row, 'still recorded even with no media');
  assert.equal(row.media_path, null, 'nothing was downloadable');
});

// ── mock harness integrity ───────────────────────────────────────────
test('harness: view-once injection produces a message the bot can capture', async () => {
  const socket = new MockWhatsAppSocket({ logger: quiet });
  let seen = null;
  socket.on('messages.upsert', ({ messages }) => {
    seen = messages[0];
  });
  // A real view-once always carries a media payload, as the harness does.
  await socket.inject('secret photo', {
    from: MOM,
    viewOnce: true,
    media: { imageMessage: { mimetype: 'image/jpeg', fileLength: 48213 } },
  });

  assert.ok(seen.message.viewOnceMessageV2, 'must be wrapped in the real envelope');
  const { normalize } = await import('../src/core/message.js');
  const msg = normalize(seen);
  assert.equal(msg.viewOnce, true);
  assert.equal(msg.text, 'secret photo', 'caption survives the envelope');
  assert.equal(msg.media?.mimetype, 'image/jpeg');
});

test('harness: presence injection carries the shape Baileys uses', async () => {
  const socket = new MockWhatsAppSocket({ logger: quiet });
  let payload = null;
  socket.on('presence.update', (p) => {
    payload = p;
  });
  await socket.injectPresence(MOM, 'unavailable');

  assert.equal(payload.id, MOM);
  assert.equal(payload.presences[MOM], 'unavailable');
});
