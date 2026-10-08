import { createCipheriv, hkdfSync } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '@whiskeysockets/baileys';
import { createLogger } from '../src/core/logger.js';
import { extractEdit } from '../src/core/editWatch.js';
import processMessage from '../node_modules/@whiskeysockets/baileys/lib/Utils/process-message.js';
import { decryptMessageNode } from '../node_modules/@whiskeysockets/baileys/lib/Utils/decode-wa-message.js';
import {
  isEncryptedMessageEdit,
  processEncryptedMessageEdit,
} from '../node_modules/@whiskeysockets/baileys/lib/Utils/decrypt-message-edit.js';

const logger = createLogger('fatal');
const SENDER = '15550001111@s.whatsapp.net';
const ME = '15550002222@s.whatsapp.net';
const ORIGINAL_ID = 'ORIGINAL-MSG-1';
const ENVELOPE_ID = 'EDIT-ENVELOPE-1';
const SECRET = Buffer.alloc(32, 37);

function sealEdit({ sender = SENDER, editor = SENDER, originalId = ORIGINAL_ID, text = 'after' } = {}) {
  const targetMessageKey = { remoteJid: sender, id: originalId, fromMe: false };
  const protocolMessage = {
    protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
      key: targetMessageKey,
      editedMessage: { conversation: text },
      timestampMs: 1_760_000_000_000,
    },
  };
  const info = Buffer.concat([
    Buffer.from(originalId),
    Buffer.from(sender),
    Buffer.from(editor),
    Buffer.from('Message Edit'),
  ]);
  // Independent RFC 5869 implementation, rather than the matching HMAC helper
  // used by the Baileys decryptor under test.
  const decryptionKey = Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(32), info, 32));
  const iv = Buffer.alloc(12, 11);
  const cipher = createCipheriv('aes-256-gcm', decryptionKey, iv);
  const encoded = proto.Message.encode(protocolMessage).finish();
  const ciphertext = Buffer.concat([cipher.update(encoded), cipher.final(), cipher.getAuthTag()]);

  return {
    targetMessageKey,
    encPayload: ciphertext,
    encIv: iv,
    secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
  };
}

function makeEnvelope(secretEncryptedMessage) {
  return {
    key: { remoteJid: SENDER, fromMe: false, id: ENVELOPE_ID },
    message: { secretEncryptedMessage },
    messageTimestamp: 1_760_000_000,
  };
}

function originalMessage() {
  return { messageContextInfo: { messageSecret: SECRET } };
}

const lidMapping = {
  async getLIDForPN() { return null; },
  async getPNForLID() { return null; },
};

test('Baileys preserves the outer message secret while unwrapping device-sent messages', async () => {
  const encoded = proto.Message.encode({
    deviceSentMessage: {
      message: {
        conversation: 'original text',
        messageContextInfo: { messageAddOnDurationInSecs: 900 },
      },
    },
    messageContextInfo: { messageSecret: SECRET },
  }).finish();
  const stanza = {
    attrs: { id: ORIGINAL_ID, from: SENDER, t: '1760000000' },
    content: [{ tag: 'plaintext', attrs: {}, content: encoded }],
  };
  const decoded = decryptMessageNode(stanza, ME, undefined, { lidMapping }, logger);
  await decoded.decrypt();

  assert.equal(decoded.fullMessage.message.conversation, 'original text');
  assert.deepEqual(decoded.fullMessage.message.messageContextInfo.messageSecret, SECRET);
  assert.equal(decoded.fullMessage.message.messageContextInfo.messageAddOnDurationInSecs, 900);
  assert.equal(decoded.fullMessage.message.deviceSentMessage, undefined);
});

test('Baileys decrypts secret-encrypted MESSAGE_EDIT and emits the normal edit update', async () => {
  const secretEncryptedMessage = sealEdit();
  assert.equal(isEncryptedMessageEdit({ secretEncryptedMessage }), true);
  const events = [];

  await processMessage(makeEnvelope(secretEncryptedMessage), {
    shouldProcessHistoryMsg: false,
    placeholderResendCache: null,
    ev: { emit: (event, payload) => events.push({ event, payload }) },
    creds: { me: { id: ME }, accountSettings: {} },
    signalRepository: { lidMapping },
    keyStore: {},
    logger,
    options: {},
    getMessage: async (key) => {
      assert.equal(key.id, ORIGINAL_ID);
      assert.equal(key.remoteJid, SENDER);
      assert.equal(key.fromMe, false);
      return originalMessage();
    },
  });

  const updateEvent = events.find(({ event }) => event === 'messages.update');
  assert.ok(updateEvent, 'Baileys must emit messages.update for the decrypted edit');
  assert.equal(updateEvent.payload[0].key.id, ORIGINAL_ID);
  const edit = extractEdit(updateEvent.payload[0]);
  assert.deepEqual(edit, { stanzaId: ORIGINAL_ID, newText: 'after' });
});

test('encrypted edit processing fails closed without the original 32-byte message secret', async () => {
  const result = await processEncryptedMessageEdit({
    message: makeEnvelope(sealEdit()),
    secretEncryptedMessage: sealEdit(),
    getMessage: async () => ({ conversation: 'not a stored protobuf' }),
    lidMapping,
    logger,
    meId: ME,
  });
  assert.equal(result, undefined);
});
