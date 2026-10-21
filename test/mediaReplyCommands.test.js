import test from 'node:test';
import assert from 'node:assert/strict';

import { createLogger } from '../src/core/logger.js';
import { normalize } from '../src/core/message.js';
import aiPlugin from '../src/plugins/ai.js';
import mediaPlugin from '../src/plugins/media.js';

const quiet = createLogger('fatal');
const OWNER = '15550001111@s.whatsapp.net';

function quotedCommand({ command, quotedMessage, quotedId = 'QUOTED' }) {
  const raw = {
    key: { id: 'COMMAND', remoteJid: OWNER, fromMe: false },
    message: {
      extendedTextMessage: {
        text: command,
        contextInfo: {
          stanzaId: quotedId,
          remoteJid: OWNER,
          participant: OWNER,
          quotedMessage,
        },
      },
    },
  };
  return normalize(raw);
}

test('.vision downloads and analyses the image explicitly quoted by a text command', async () => {
  const vision = aiPlugin.commands.find((command) => command.name === 'vision');
  const replies = [];
  const downloads = [];
  let request;
  const ctx = {
    args: ['read', 'the', 'sign'],
    text: 'read the sign',
    msg: quotedCommand({
      command: '.vision read the sign',
      quotedId: 'IMAGE-1',
      quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } },
    }),
    socket: {
      async downloadMediaMessage(raw) {
        downloads.push(raw);
        return Buffer.from('image bytes');
      },
    },
    logger: quiet,
    bot: {
      ai: {
        async complete(value) { request = value; return 'The sign says Nexus.'; },
      },
    },
    reply: async (text) => replies.push(String(text)),
  };

  await vision.execute(ctx);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].key.id, 'IMAGE-1');
  assert.equal(request.prompt, 'read the sign');
  assert.deepEqual(request.images, [Buffer.from('image bytes').toString('base64')]);
  assert.match(replies.at(-1), /The sign says Nexus/);
});

test('.transcribe downloads and transcribes the audio explicitly quoted by a text command', async () => {
  const transcribe = mediaPlugin.commands.find((command) => command.name === 'transcribe');
  const replies = [];
  const downloads = [];
  let request;
  const ctx = {
    args: [],
    text: '',
    msg: quotedCommand({
      command: '.transcribe',
      quotedId: 'AUDIO-1',
      quotedMessage: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } },
    }),
    socket: {
      async downloadMediaMessage(raw) {
        downloads.push(raw);
        return Buffer.from('audio bytes');
      },
    },
    logger: quiet,
    bot: {
      ai: {
        configured: () => true,
        async transcribeAudio(value) { request = value; return 'This is the quoted voice note.'; },
      },
    },
    reply: async (text) => replies.push(String(text)),
  };

  await transcribe.execute(ctx);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].key.id, 'AUDIO-1');
  assert.equal(request.mime, 'audio/ogg; codecs=opus');
  assert.equal(request.base64, Buffer.from('audio bytes').toString('base64'));
  assert.match(replies.at(-1), /This is the quoted voice note/);
});
