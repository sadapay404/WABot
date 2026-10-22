/**
 * Nexus-WA — turn a WhatsApp media message into a normal downloadable file.
 *
 * Voice notes, stickers and video notes are convenient inside WhatsApp but do
 * not always show a clear “save to Files” action. Re-sending their unchanged
 * bytes as a document makes the file downloadable without transcoding it.
 */

import path from 'node:path';
import { downloadWhatsAppMedia } from '../core/mediaDownloader.js';
import { extractMediaType, extractQuotedRaw, normalize } from '../core/message.js';

const MAX_SAVE_BYTES = 100 * 1024 * 1024;

const EXTENSION_BY_MIME = [
  [/ogg|opus/i, 'ogg'],
  [/mpeg|mp3/i, 'mp3'],
  [/mp4|m4a|aac/i, 'm4a'],
  [/wav/i, 'wav'],
  [/webm/i, 'webm'],
  [/jpeg|jpg/i, 'jpg'],
  [/png/i, 'png'],
  [/gif/i, 'gif'],
  [/webp/i, 'webp'],
  [/heic|heif/i, 'heic'],
  [/pdf/i, 'pdf'],
  [/zip/i, 'zip'],
  [/plain/i, 'txt'],
];

function safeName(value) {
  // Treat both Windows and POSIX separators as paths, then retain only the
  // terminal file name. A sender-controlled document name must never create
  // a path on the host or show a misleading parent-directory prefix.
  const terminal = String(value || '').replace(/\\/g, '/').split('/').pop();
  const clean = String(terminal || '')
    .replace(/[\0\r\n]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100);
  return clean || null;
}

/** Derive a useful file extension without trusting the sender's file name. */
export function extensionForMedia(media) {
  const mime = String(media?.mimetype || '');
  const byMime = EXTENSION_BY_MIME.find(([pattern]) => pattern.test(mime))?.[1];
  if (byMime) return byMime;
  if (media?.type === 'sticker') return 'webp';
  if (media?.type === 'audio') return 'ogg';
  if (media?.type === 'video') return 'mp4';
  if (media?.type === 'image') return 'jpg';
  return 'bin';
}

/** Create a Files-friendly, harmless document name. */
export function savedFileName(media, stanzaId = '') {
  const original = safeName(media?.payload?.fileName);
  const ext = extensionForMedia(media);
  if (original) {
    const originalExt = path.extname(original).slice(1).toLowerCase();
    return originalExt ? original : `${original}.${ext}`;
  }

  const stem = media?.type === 'audio'
    ? 'voice-message'
    : media?.type === 'sticker'
      ? 'sticker'
      : `${media?.type || 'media'}-file`;
  const suffix = String(stanzaId || Date.now()).replace(/[^A-Za-z0-9_-]/g, '').slice(-18) || 'saved';
  return `${stem}-${suffix}.${ext}`;
}

/**
 * Select media attached to `.save` itself, or media nested in a replied-to
 * message. This is deliberately limited to media the user explicitly points
 * at; it never searches chat history.
 */
export function saveSource(normalizedMessage) {
  if (normalizedMessage?.media) {
    return {
      raw: normalizedMessage.raw,
      media: normalizedMessage.media,
      normalized: normalizedMessage,
      quoted: false,
    };
  }

  const quotedRaw = extractQuotedRaw(normalizedMessage?.raw);
  if (!quotedRaw) return null;
  const media = extractMediaType(quotedRaw.message);
  if (!media) return null;
  return { raw: quotedRaw, media, normalized: normalize(quotedRaw), quoted: true };
}

function fileSize(payload) {
  const value = Number(payload?.fileLength);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function label(media) {
  if (media?.type === 'audio') return 'voice message';
  if (media?.type === 'sticker') return 'sticker';
  if (media?.type === 'video') return 'video';
  if (media?.type === 'image') return 'image';
  return 'file';
}

export default {
  category: 'media',
  commands: [
    {
      name: 'save',
      aliases: ['asfile', 'download'],
      description: 'Re-send a voice note, sticker, video, image, or document as a downloadable file',
      usage: 'Reply to media with .save, or use .save in its caption',
      ownerOnly: false,
      async execute(ctx) {
        const source = saveSource(ctx.msg);
        if (!source) {
          return ctx.reply('Reply to a voice message, sticker, image, video, or document with `.save`. You can also put `.save` in its caption.');
        }
        if (source.normalized?.viewOnce) {
          return ctx.reply('⚠️ `.save` does not bypass WhatsApp view-once media. It can save ordinary media that is still available in this chat.');
        }

        const declaredSize = fileSize(source.media.payload);
        if (declaredSize != null && declaredSize > MAX_SAVE_BYTES) {
          return ctx.reply(`⚠️ That ${label(source.media)} is over the ${Math.round(MAX_SAVE_BYTES / 1024 / 1024)} MB safety limit, so it was not downloaded.`);
        }

        let buffer;
        try {
          buffer = await downloadWhatsAppMedia(ctx.socket, source.raw, ctx.logger);
        } catch (err) {
          return ctx.reply(`⚠️ Could not retrieve that ${label(source.media)}. It may have expired or been removed: ${String(err.message).slice(0, 160)}`);
        }
        if (!buffer?.length) return ctx.reply('⚠️ WhatsApp returned an empty media file, so there is nothing to save.');
        if (buffer.length > MAX_SAVE_BYTES) {
          return ctx.reply(`⚠️ That ${label(source.media)} is over the ${Math.round(MAX_SAVE_BYTES / 1024 / 1024)} MB safety limit, so it was not re-sent.`);
        }

        const mimetype = source.media.mimetype || 'application/octet-stream';
        const fileName = savedFileName(source.media, source.raw?.key?.id);
        await ctx.send(
          ctx.jid,
          {
            document: buffer,
            mimetype,
            fileName,
            caption: `💾 *Saved as a downloadable file*\n\n${label(source.media)} → \`${fileName}\`\n_Tap the document to download it to Files._`,
          },
          { quoted: ctx.msg.raw }
        );
      },
    },
  ],
};
