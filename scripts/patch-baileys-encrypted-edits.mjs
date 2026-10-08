#!/usr/bin/env node
/**
 * Backport Baileys' encrypted MESSAGE_EDIT handling to the pinned rc14 build.
 * The upstream implementation is based on WhiskeySockets/Baileys PR #2743.
 * Refuse unknown package/source versions rather than applying a partial edit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAILEYS = path.join(ROOT, 'node_modules/@whiskeysockets/baileys');
const EXPECTED_VERSION = '7.0.0-rc14';

if (!fs.existsSync(path.join(BAILEYS, 'package.json'))) {
  console.log('[nexus] Baileys not installed; skipping encrypted-edit patch.');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(BAILEYS, 'package.json'), 'utf8'));
if (pkg.version !== EXPECTED_VERSION) {
  throw new Error(
    `[nexus] encrypted-edit patch expects Baileys ${EXPECTED_VERSION}; found ${pkg.version}. ` +
      'Review the upstream source before changing the pinned dependency.'
  );
}

function patch(relativePath, marker, before, after, label) {
  const file = path.join(BAILEYS, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(marker)) return;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[nexus] Could not apply Baileys encrypted-edit patch: ${label} source changed.`);
  }
  fs.writeFileSync(file, source.slice(0, first) + after + source.slice(first + before.length));
  console.log(`[nexus] Applied Baileys encrypted-edit patch: ${label}`);
}

const helperSource = path.join(ROOT, 'patches/baileys/decrypt-message-edit.js');
const helperTarget = path.join(BAILEYS, 'lib/Utils/decrypt-message-edit.js');
if (!fs.existsSync(helperSource)) throw new Error('[nexus] encrypted-edit helper source is missing.');
if (!fs.existsSync(helperTarget) || fs.readFileSync(helperTarget, 'utf8') !== fs.readFileSync(helperSource, 'utf8')) {
  fs.copyFileSync(helperSource, helperTarget);
  console.log('[nexus] Installed Baileys encrypted-edit helper');
}

patch(
  'lib/Utils/process-message.js',
  "import { isEncryptedMessageEdit, processEncryptedMessageEdit } from './decrypt-message-edit.js';",
  "import { aesDecryptGCM, hmacSign } from './crypto.js';",
  "import { aesDecryptGCM, hmacSign } from './crypto.js';\nimport { isEncryptedMessageEdit, processEncryptedMessageEdit } from './decrypt-message-edit.js';",
  'encrypted MESSAGE_EDIT dispatch'
);

patch(
  'lib/Utils/process-message.js',
  '!isEncryptedMessageEdit(normalizedContent)',
  '        !normalizedContent?.pollUpdateMessage);',
  '        !normalizedContent?.pollUpdateMessage &&\n        !isEncryptedMessageEdit(normalizedContent));',
  'exclude encrypted edits from normal-message accounting'
);

patch(
  'lib/Utils/process-message.js',
  'else if (isEncryptedMessageEdit(content))',
  '    else if (message.messageStubType) {',
  `    else if (isEncryptedMessageEdit(content)) {
        try {
            const update = await processEncryptedMessageEdit({
                message,
                secretEncryptedMessage: content.secretEncryptedMessage,
                getMessage,
                lidMapping: signalRepository.lidMapping,
                logger,
                meId,
                meLid: creds.me?.lid
            });
            if (update) {
                ev.emit('messages.update', [update]);
            }
        }
        catch (err) {
            logger.warn({ err, msgId: message.key.id }, 'failed to process encrypted message edit');
        }
    }
    else if (message.messageStubType) {`,
  'decrypt encrypted MESSAGE_EDIT envelopes'
);

patch(
  'lib/Utils/decode-wa-message.js',
  'const innerMessage = msg.deviceSentMessage.message;',
  '                        msg = msg.deviceSentMessage?.message || msg;',
  `                        if (msg.deviceSentMessage?.message) {
                            const innerMessage = msg.deviceSentMessage.message;
                            const outerMessage = { ...msg };
                            delete outerMessage.deviceSentMessage;
                            // Linked-device messages can keep messageSecret on the outer wrapper.
                            msg = {
                                ...outerMessage,
                                ...innerMessage,
                                ...(outerMessage.messageContextInfo || innerMessage.messageContextInfo
                                    ? {
                                          messageContextInfo: {
                                              ...outerMessage.messageContextInfo,
                                              ...innerMessage.messageContextInfo
                                          }
                                      }
                                    : {})
                            };
                        }`,
  'preserve the original message secret when unwrapping device-sent messages'
);
