import test from 'node:test';
import assert from 'node:assert/strict';

import savePlugin, { extensionForMedia, savedFileName, saveSource } from '../src/plugins/save.js';
import { normalize } from '../src/core/message.js';

const command = savePlugin.commands[0];
const CHAT = '120363000000000001@g.us';
const SENDER = '15550002222@s.whatsapp.net';

function commandRaw({ quotedMessage = null, media = null, viewOnce = false } = {}) {
  const message = quotedMessage
    ? {
        extendedTextMessage: {
          text: '.save',
          contextInfo: { stanzaId: 'quoted-media', participant: SENDER, quotedMessage },
        },
      }
    : media
      ? { [Object.keys(media)[0]]: { ...Object.values(media)[0], caption: '.save' } }
      : { conversation: '.save' };
  return {
    key: { id: 'save-command', remoteJid: CHAT, participant: SENDER, fromMe: false },
    message,
    messageTimestamp: 1,
  };
}

function mediaRaw(type, payload, { viewOnce = false } = {}) {
  const message = { [`${type}Message`]: payload };
  return {
    key: { id: 'media-original', remoteJid: CHAT, participant: SENDER, fromMe: false },
    message: viewOnce ? { viewOnceMessageV2: { message } } : message,
    messageTimestamp: 1,
  };
}

function context(raw, bytes = Buffer.from('media bytes')) {
  const out = [];
  return {
    msg: normalize(raw),
    jid: CHAT,
    socket: {
      async downloadMediaMessage(message) {
        assert.ok(message?.message, 'the original Baileys media wrapper is downloaded');
        return bytes;
      },
    },
    logger: { warn() {}, error() {} },
    async send(jid, content, options) { out.push({ jid, content, options }); },
    async reply(text) { out.push({ reply: text }); },
    out,
  };
}

test('.save converts a replied-to voice message into a downloadable OGG document', async () => {
  const quotedMessage = {
    audioMessage: {
      mimetype: 'audio/ogg; codecs=opus',
      seconds: 18,
      mediaKey: Buffer.alloc(32).toString('base64'),
      directPath: '/voice',
    },
  };
  const ctx = context(commandRaw({ quotedMessage }));
  await command.execute(ctx);

  assert.equal(ctx.out.length, 1);
  const sent = ctx.out[0];
  assert.equal(sent.jid, CHAT);
  assert.deepEqual(sent.content.document, Buffer.from('media bytes'));
  assert.equal(sent.content.mimetype, 'audio/ogg; codecs=opus');
  assert.match(sent.content.fileName, /^voice-message-quoted-media\.ogg$/);
  assert.match(sent.content.caption, /Saved as a downloadable file/);
  assert.equal(sent.options.quoted, ctx.msg.raw);
});

test('.save also works when used in an attached voice-message caption', async () => {
  const raw = commandRaw({
    media: {
      audioMessage: {
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        mediaKey: Buffer.alloc(32).toString('base64'),
        directPath: '/voice',
      },
    },
  });
  const ctx = context(raw);
  await command.execute(ctx);
  assert.equal(ctx.out[0].content.document.toString(), 'media bytes');
  assert.match(ctx.out[0].content.fileName, /^voice-message-save-command\.ogg$/);
});

test('.save refuses view-once media and never downloads it', async () => {
  const quotedMessage = {
    viewOnceMessageV2: {
      message: {
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', mediaKey: 'a', directPath: '/voice' },
      },
    },
  };
  const ctx = context(commandRaw({ quotedMessage }));
  await command.execute(ctx);
  assert.equal(ctx.out.length, 1);
  assert.match(ctx.out[0].reply, /does not bypass WhatsApp view-once/i);
});

test('.save detects a document source and preserves its safe original filename', () => {
  const raw = mediaRaw('document', { mimetype: 'application/pdf', fileName: '../../report.pdf' });
  const source = saveSource(normalize(raw));
  assert.equal(source.media.type, 'document');
  assert.equal(extensionForMedia(source.media), 'pdf');
  assert.equal(savedFileName(source.media, 'abc'), 'report.pdf');
});

test('.save rejects a reply that has no media', async () => {
  const ctx = context(commandRaw({ quotedMessage: { conversation: 'just text' } }));
  await command.execute(ctx);
  assert.match(ctx.out[0].reply, /Reply to a voice message/i);
});
