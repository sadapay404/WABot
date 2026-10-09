import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildConfig } from '../src/config/index.js';
import { createLogger } from '../src/core/logger.js';
import { EnvEditor } from '../src/core/envEditor.js';
import { normalize } from '../src/core/message.js';

const quiet = createLogger('fatal');
const OWNER = '15550001111@s.whatsapp.net';
const SPARE = '15550009999@s.whatsapp.net';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-env-'));
  const config = buildConfig({ mode: 'dry-run' });
  config.safety.ownerJids = [OWNER];
  const editor = new EnvEditor({ config, logger: quiet, selfJid: SPARE, filePath: path.join(dir, '.env') });
  return { dir, config, editor, file: path.join(dir, '.env') };
}

test('remote API-key entry writes atomically, redacts the value, and updates AI without restart', async () => {
  const { dir, config, editor, file } = fixture();
  const original = process.env.GROQ_API_KEY;
  const sent = [];
  try {
    editor.startSecret({ ownerJid: OWNER, chatJid: OWNER, key: 'GROQ_API_KEY' });
    const appendReplay = await editor.consumePending({
      msg: { sender: OWNER, jid: OWNER, text: 'old history', upsertType: 'append' },
      socket: { async sendMessage(...args) { sent.push(args); } },
      isOwner: true,
    });
    assert.equal(appendReplay, true, 'history replay must be dropped before it can enter a cache');
    assert.equal(editor.pending.size, 1, 'history replay must not consume the pending secret');
    assert.equal(fs.existsSync(file), false);

    const secret = 'test-key-must-not-be-logged';
    const consumed = await editor.consumePending({
      msg: { sender: OWNER, jid: OWNER, text: secret, upsertType: 'notify', isGroup: false },
      socket: { async sendMessage(jid, content) { sent.push({ jid, content }); } },
      isOwner: true,
    });
    assert.equal(consumed, true);
    assert.equal(config.ai.keys.groq, secret, 'new key is active in the running AI client');
    assert.match(fs.readFileSync(file, 'utf8'), /GROQ_API_KEY=/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'configuration file is owner-readable only');
    assert.doesNotMatch(sent.at(-1).content.text, new RegExp(secret));
    assert.doesNotMatch(editor.status(), new RegExp(secret));
  } finally {
    if (original === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a linked self-chat prompt echo is not mistaken for the API key', async () => {
  const { dir, editor, file } = fixture();
  try {
    editor.startSecret({ ownerJid: SPARE, chatJid: SPARE, key: 'GROQ_API_KEY', promptText: 'enter key now' });
    editor.setPromptMessageId({ ownerJid: SPARE, chatJid: SPARE, messageId: 'PROMPT-ID' });
    const msg = {
      sender: SPARE, jid: SPARE, id: 'PROMPT-ID', text: 'Echo text differed',
      isBot: true, isGroup: false, upsertType: 'notify',
    };
    const consumed = await editor.consumePending({
      msg,
      socket: { async sendMessage() { assert.fail('prompt echo should not trigger a response'); } },
      isOwner: true,
    });
    assert.equal(consumed, false);
    assert.equal(editor.pending.size, 1, 'echo leaves secret entry waiting for the owner');
    assert.equal(fs.existsSync(file), false, 'prompt text is never saved as a key');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pending secret sent from another chat is cancelled and marked sensitive', async () => {
  const { dir, editor, file } = fixture();
  try {
    editor.startSecret({ ownerJid: OWNER, chatJid: OWNER, key: 'GROQ_API_KEY' });
    const msg = {
      sender: OWNER, jid: '120363000000000000@g.us', text: 'must not enter cache',
      isGroup: true, upsertType: 'notify',
    };
    const sent = [];
    const consumed = await editor.consumePending({
      msg,
      socket: { async sendMessage(jid, content) { sent.push({ jid, content }); } },
      isOwner: true,
    });
    assert.equal(consumed, true);
    assert.equal(msg.sensitive, true);
    assert.match(sent[0].content.text, /cancelled/);
    assert.equal(fs.existsSync(file), false, 'wrong-chat text is not written to configuration');
    assert.equal(editor.pending.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owner additions update the running whitelist; the final owner cannot be removed', () => {
  const { dir, config, editor } = fixture();
  const original = process.env.OWNER_JIDS;
  try {
    assert.deepEqual(editor.addOwner('15550009999').jid, SPARE);
    assert.deepEqual(config.safety.ownerJids, [OWNER, SPARE]);
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /OWNER_JIDS=/);
    assert.equal(editor.removeOwner('15550009999').changed, true);
    assert.deepEqual(config.safety.ownerJids, [OWNER]);
    assert.throws(() => editor.removeOwner(OWNER), /at least one owner must remain/);
  } finally {
    if (original === undefined) delete process.env.OWNER_JIDS;
    else process.env.OWNER_JIDS = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configuration entry messages are marked sensitive and inline API keys are refused', () => {
  const { dir, editor } = fixture();
  try {
    const envCommand = normalize({
      key: { remoteJid: OWNER, fromMe: false, id: 'ENV-CMD' },
      message: { conversation: '.env set GROQ_API_KEY test-secret' },
    });
    assert.equal(editor.shouldSkipMessage(envCommand), true);
    assert.throws(() => editor.setValue('GROQ_API_KEY', 'test-secret'), /next message, not inline/);
    assert.equal(fs.existsSync(path.join(dir, '.env')), false, 'refused inline value must not be saved');

    const ordinary = normalize({
      key: { remoteJid: OWNER, fromMe: false, id: 'ORDINARY' },
      message: { conversation: 'hello' },
    });
    assert.equal(editor.shouldSkipMessage(ordinary), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
