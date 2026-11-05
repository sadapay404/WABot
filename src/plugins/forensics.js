/** Local, reply-based media forensics. No media is sent to an AI provider. */

import path from 'node:path';
import { downloadWhatsAppMedia } from '../core/mediaDownloader.js';
import {
  cleanImageMetadata,
  decodeQr,
  documentSummaryLines,
  hammingDistanceHex,
  inspectMedia,
  metadataSummary,
  perceptualHash,
  rawMetadataText,
  timelineSummary,
} from '../core/forensics.js';
import { saveSource } from './save.js';

function displaySource(media) {
  if (media?.type === 'audio') return 'voice message or audio file';
  if (media?.type === 'image') return 'image';
  if (media?.type === 'video') return 'video';
  if (media?.type === 'sticker') return 'sticker';
  return 'document';
}

function cleanFileName(report) {
  const name = String(report.fileName || `image.${report.detected.ext || 'bin'}`)
    .replace(/[\\/\0\r\n]/g, '_').replace(/^\.+/, '').slice(0, 100);
  const parsed = path.parse(name);
  return `${parsed.name || 'image'}-clean${parsed.ext || `.${report.detected.ext || 'bin'}`}`;
}

async function target(ctx) {
  const source = saveSource(ctx.msg);
  if (!source) {
    await ctx.reply('Reply to an image, video, audio, sticker, or document with this command. You can also put the command in the media caption.');
    return null;
  }
  if (source.normalized?.viewOnce) {
    await ctx.reply('⚠️ Media forensics does not bypass WhatsApp view-once media. Reply to ordinary media that is still available in the chat.');
    return null;
  }
  let buffer;
  try {
    buffer = await downloadWhatsAppMedia(ctx.socket, source.raw, ctx.logger);
  } catch (err) {
    await ctx.reply(`⚠️ Could not retrieve that ${displaySource(source.media)}: ${String(err.message).slice(0, 160)}`);
    return null;
  }
  try {
    const report = await inspectMedia(buffer, { media: source.media, stanzaId: source.raw?.key?.id || '' });
    return { source, buffer, report };
  } catch (err) {
    await ctx.reply(`⚠️ Could not inspect that file: ${String(err.message).slice(0, 180)}`);
    return null;
  }
}

function fileSummary(report) {
  const lines = [
    '📦 *FILE X-RAY*', '',
    `Shown filename: ${report.fileName || 'none'}`,
    `Declared type: ${report.declaredMime || 'none'}`,
    `Detected type: ${report.detected.mime} (.${report.detected.ext})`,
    `SHA-256: ${report.sha256}`,
  ];
  if (report.extensionMismatch) lines.push(`⚠️ The filename says .${report.nameExt}; the bytes identify as .${report.detected.ext}.`);
  else lines.push('✓ Filename extension and detected type do not conflict.');
  if (report.document?.macros) lines.push('⚠️ Office macro payload detected.');
  if (report.document?.javascript) lines.push('⚠️ Embedded PDF JavaScript marker detected.');
  if (report.document?.externalLinks?.length) lines.push(`External links: ${report.document.externalLinks.join(', ')}`);
  lines.push('', '_This checks file structure and metadata; it is not an antivirus verdict._');
  return lines.join('\n');
}

function videoSummary(report) {
  if (!report.av) return 'That reply is not a readable audio/video file.';
  const lines = metadataSummary({ ...report, image: null, document: null });
  return lines.replace('🧬 *MEDIA X-RAY*', '🎬 *VIDEO X-RAY*');
}

function audioSummary(report) {
  if (!report.av) return 'That reply is not a readable audio/video file.';
  const lines = metadataSummary({ ...report, image: null, document: null });
  return lines.replace('🧬 *MEDIA X-RAY*', '🎤 *AUDIO X-RAY*');
}

function ensureFingerprints(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_fingerprints (
      sha256 TEXT PRIMARY KEY,
      dhash TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1,
      first_chat_jid TEXT,
      first_stanza_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_media_fingerprint_dhash ON media_fingerprints(dhash);
  `);
}

function recordFingerprint(ctx, report, dhash) {
  ensureFingerprints(ctx.db);
  const prior = ctx.db.prepare('SELECT * FROM media_fingerprints WHERE sha256 = ?').get(report.sha256);
  const now = Date.now();
  if (prior) {
    ctx.db.prepare('UPDATE media_fingerprints SET last_seen = ?, seen_count = seen_count + 1 WHERE sha256 = ?').run(now, report.sha256);
  } else {
    ctx.db.prepare(
      'INSERT INTO media_fingerprints (sha256, dhash, first_seen, last_seen, seen_count, first_chat_jid, first_stanza_id) VALUES (?, ?, ?, ?, 1, ?, ?)'
    ).run(report.sha256, dhash, now, now, ctx.jid, report.stanzaId || null);
  }
  let near = null;
  if (dhash) {
    const candidates = ctx.db.prepare('SELECT * FROM media_fingerprints WHERE dhash IS NOT NULL AND sha256 <> ? ORDER BY last_seen DESC LIMIT 250').all(report.sha256);
    for (const candidate of candidates) {
      const distance = hammingDistanceHex(dhash, candidate.dhash);
      if (distance != null && distance <= 8 && (!near || distance < near.distance)) near = { ...candidate, distance };
    }
  }
  return { prior, near };
}

function fingerprintSummary(report, dhash, match) {
  const lines = ['🔐 *MEDIA FINGERPRINT*', '', `SHA-256: ${report.sha256}`];
  if (dhash) lines.push(`Visual dHash: ${dhash}`);
  if (match.prior) {
    lines.push(`✓ Exact same bytes were already seen ${match.prior.seen_count} time${match.prior.seen_count === 1 ? '' : 's'} before.`);
  } else lines.push('✓ No earlier exact-byte match is stored by this bot.');
  if (match.near) lines.push(`≈ A visually similar archived image exists (dHash distance ${match.near.distance}/64; not proof it is the same source).`);
  lines.push('', '_Only hashes are recorded for comparison; the command does not upload the media or perform an internet reverse-image search._');
  return lines.join('\n');
}

function qrSummary(value) {
  const suspicious = /@|xn--|\b(?:login|verify|wallet|bonus|claim)\b/i.test(value);
  const lines = ['🔎 *QR DECODED*', '', value];
  if (/^https?:\/\//i.test(value)) lines.push('', suspicious ? '⚠️ Inspect the address carefully before opening it.' : '_Check the domain before opening any QR link._');
  return lines.join('\n');
}

export default {
  category: 'forensics',
  commands: [
    {
      name: 'md', aliases: ['metadata', 'xray'], ownerOnly: false,
      description: 'Reveal embedded metadata from a replied-to file; add full for every readable field',
      usage: 'Reply to media with .md [full]',
      async execute(ctx) {
        const item = await target(ctx); if (!item) return;
        await ctx.reply(metadataSummary(item.report));
        if (/\bfull\b/i.test(ctx.text || '')) {
          const text = rawMetadataText(item.report);
          await ctx.send(ctx.jid, {
            document: Buffer.from(text), mimetype: 'text/plain',
            fileName: `metadata-${item.report.sha256.slice(0, 12)}.txt`,
            caption: '📄 Full readable metadata fields',
          }, { quoted: ctx.msg.raw });
        }
      },
    },
    {
      name: 'where', aliases: ['gps', 'geotag'], ownerOnly: false,
      description: 'Show a map link only when an image has embedded GPS coordinates',
      usage: 'Reply to an image with .where',
      async execute(ctx) {
        const item = await target(ctx); if (!item) return;
        const { latitude, longitude } = item.report.image || {};
        if (latitude == null || longitude == null) return ctx.reply('📍 No embedded GPS coordinates were found in that file. Normal WhatsApp photos often have this data removed; document-mode originals are more likely to retain it.');
        await ctx.reply(`📍 *Embedded capture location*\n\n${latitude.toFixed(6)}, ${longitude.toFixed(6)}\nhttps://www.google.com/maps/search/?api=1&query=${latitude},${longitude}\n\n_This is file metadata, not live tracking._`);
      },
    },
    {
      name: 'file', aliases: ['filexray'], ownerOnly: false,
      description: 'Compare a file name/type with its actual binary signature',
      usage: 'Reply to any file with .file',
      async execute(ctx) { const item = await target(ctx); if (item) await ctx.reply(fileSummary(item.report)); },
    },
    {
      name: 'docxray', aliases: ['docmeta', 'pdfxray'], ownerOnly: false,
      description: 'Read PDF and Office document properties, links, and macro markers',
      usage: 'Reply to a PDF or Office document with .docxray',
      async execute(ctx) {
        const item = await target(ctx); if (!item) return;
        if (!item.report.document) return ctx.reply('Reply to a PDF, DOCX, XLSX, PPTX, or ZIP-based Office document with `.docxray`.');
        await ctx.reply(documentSummaryLines(item.report.document).join('\n'));
      },
    },
    {
      name: 'videoxray', aliases: ['vmeta'], ownerOnly: false,
      description: 'Read video container, codec, tracks, timestamps, and tags',
      usage: 'Reply to a video with .videoxray',
      async execute(ctx) { const item = await target(ctx); if (item) await ctx.reply(videoSummary(item.report)); },
    },
    {
      name: 'audioxray', aliases: ['ameta'], ownerOnly: false,
      description: 'Read audio/voice codec, duration, tags, and technical details',
      usage: 'Reply to audio with .audioxray',
      async execute(ctx) { const item = await target(ctx); if (item) await ctx.reply(audioSummary(item.report)); },
    },
    {
      name: 'qr', aliases: ['decodeqr'], ownerOnly: false,
      description: 'Decode a QR code from a replied-to image or sticker',
      usage: 'Reply to an image/sticker with .qr',
      async execute(ctx) {
        const item = await target(ctx); if (!item) return;
        if (!/^image\//.test(item.report.detected.mime)) return ctx.reply('Reply to an image or sticker with `.qr`.');
        try {
          const value = await decodeQr(item.buffer);
          await ctx.reply(value ? qrSummary(value) : '🔎 No QR code was detected in that image.');
        } catch (err) { await ctx.reply(`⚠️ QR scan failed: ${String(err.message).slice(0, 150)}`); }
      },
    },
    {
      name: 'fingerprint', aliases: ['hash'], ownerOnly: false,
      description: 'Create an exact file hash and locally compare image fingerprints',
      usage: 'Reply to any media with .fingerprint',
      async execute(ctx) {
        const item = await target(ctx); if (!item) return;
        let dhash = null;
        if (/^image\//.test(item.report.detected.mime)) {
          try { dhash = await perceptualHash(item.buffer); } catch { /* exact SHA still works */ }
        }
        const match = recordFingerprint(ctx, item.report, dhash);
        await ctx.reply(fingerprintSummary(item.report, dhash, match));
      },
    },
    {
      name: 'timeline', aliases: ['when'], ownerOnly: false,
      description: 'Compare readable capture, creation, and modification timestamps',
      usage: 'Reply to media with .timeline',
      async execute(ctx) { const item = await target(ctx); if (item) await ctx.reply(timelineSummary(item.report)); },
    },
    {
      name: 'clean', aliases: ['stripmeta'], ownerOnly: false,
      description: 'Return a JPEG, PNG, or WebP copy with common metadata blocks removed',
      usage: 'Reply to an image with .clean',
      async execute(ctx) {
        const item = await target(ctx); if (!item) return;
        try {
          const cleaned = await cleanImageMetadata(item.buffer, item.report.detected.mime);
          const fileName = cleanFileName(item.report);
          await ctx.send(ctx.jid, {
            document: cleaned, mimetype: item.report.detected.mime, fileName,
            caption: `🧼 *Metadata-clean copy*\n\nRemoved common EXIF, XMP, IPTC, text, and colour-profile metadata blocks where present.\nFile: \`${fileName}\``,
          }, { quoted: ctx.msg.raw });
        } catch (err) { await ctx.reply(`⚠️ Could not make a clean copy: ${String(err.message).slice(0, 160)}`); }
      },
    },
  ],
};
