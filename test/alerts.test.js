import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getMemoryDb } from '../src/database/index.js';
import { buildConfig } from '../src/config/index.js';
import { createLogger } from '../src/core/logger.js';
import { MessageCache } from '../src/core/messageCache.js';
import { ContactStore } from '../src/core/contactStore.js';
import { MediaStore } from '../src/core/mediaStore.js';
import { normalize } from '../src/core/message.js';
import { AntiDelete } from '../src/core/antiDelete.js';
import { EditWatch } from '../src/core/editWatch.js';
import { ViewOnceCapture } from '../src/core/viewOnce.js';
import { captureAlertJid } from '../src/core/alertRouting.js';

const quiet = createLogger('fatal');
const SPARE = '15550009999@s.whatsapp.net';
const MAIN = '15550001111@s.whatsapp.net';
const CONTACT = '15550002222@s.whatsapp.net';

function socketSink() {
  const sent = [];
  return {
    sent,
    user: { id: SPARE },
    async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: `OUT${sent.length}` } }; },
    async sendPresenceUpdate() {},
  };
}

function config() {
  const value = buildConfig({ mode: 'dry-run' });
  value.safety.ownerJids = [MAIN];
  value.safety.captureAlertJid = '';
  return value;
}

test('capture alerts prefer explicit destination, then a remote owner, then linked self-chat', () => {
  const cfg = config();
  assert.equal(captureAlertJid(cfg, SPARE), MAIN);
  cfg.safety.captureAlertJid = '15550003333';
  assert.equal(captureAlertJid(cfg, SPARE), '15550003333@s.whatsapp.net');
  cfg.safety.captureAlertJid = '120363000000000000@g.us';
  assert.equal(captureAlertJid(cfg, SPARE), MAIN, 'a group is never used as a capture-alert destination');
  cfg.safety.captureAlertJid = '';
  cfg.safety.ownerJids = [SPARE];
  assert.equal(captureAlertJid(cfg, SPARE), SPARE);
});

test('delete, edit, and view-once events from a non-owner chat are stored and alerted to the remote owner', async () => {
  const db = await getMemoryDb();
  const socket = socketSink();
  const cache = new MessageCache(db, quiet);
  const contacts = new ContactStore(db, quiet);
  contacts.upsert({ id: CONTACT, name: 'Contact' });
  const cfg = config();

  const original = {
    key: { remoteJid: CONTACT, fromMe: false, id: 'IN-1' },
    messageTimestamp: Math.floor(Date.now() / 1_000),
    message: { conversation: 'original text' },
  };
  cache.store(original, normalize(original), SPARE);

  const deleted = new AntiDelete({ socket, db, cache, contacts, registry: null, logger: quiet, config: cfg });
  await deleted.onUpdate({
    key: { remoteJid: CONTACT, fromMe: false, id: 'REVOKE-1' },
    update: { message: { protocolMessage: { type: 0, stanzaId: 'IN-1' } } },
  });
  assert.ok(db.prepare('SELECT 1 FROM deleted_messages WHERE stanza_id = ?').get('IN-1'));
  assert.equal(socket.sent.at(-1).jid, MAIN, 'delete alert goes to the configured owner, not the sender');

  cache.store({ ...original, key: { ...original.key, id: 'EDIT-1' } }, normalize({
    ...original,
    key: { ...original.key, id: 'EDIT-1' },
  }), SPARE);
  const edits = new EditWatch({ socket, db, cache, contacts, logger: quiet, config: cfg });
  await edits.onUpdate({
    key: { remoteJid: CONTACT, fromMe: false, id: 'EDIT-1' },
    update: { message: { editedMessage: { message: { conversation: 'edited text' } } } },
  });
  assert.ok(db.prepare('SELECT 1 FROM message_edits WHERE stanza_id = ?').get('EDIT-1'));
  assert.equal(socket.sent.at(-1).jid, MAIN, 'edit alert goes to the configured owner');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-alert-media-'));
  const mediaStore = new MediaStore({ db, logger: quiet, dir: temp });
  const views = new ViewOnceCapture({
    socket, db, cache, contacts, registry: null, mediaStore, logger: quiet, config: cfg,
    downloader: async () => Buffer.from('captured bytes'),
  });
  const rawViewOnce = {
    key: { remoteJid: CONTACT, fromMe: false, id: 'VO-1' },
    messageTimestamp: Math.floor(Date.now() / 1_000),
    message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 15 } } } },
  };
  const result = await views.onMessage(rawViewOnce, normalize(rawViewOnce));
  assert.equal(result.status, 'captured');
  assert.ok(db.prepare('SELECT 1 FROM view_once WHERE stanza_id = ?').get('VO-1'));
  assert.equal(socket.sent.at(-2).jid, MAIN, 'view-once alert goes to the configured owner');
  assert.equal(socket.sent.at(-1).jid, MAIN, 'captured media goes to the same owner');
  fs.rmSync(temp, { recursive: true, force: true });
});
