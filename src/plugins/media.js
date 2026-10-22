import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatBytes, timeAgo } from '../lib/format.js';
import { describeMedia, mediaIcon } from '../lib/media.js';
import { downloadWhatsAppMedia } from '../core/mediaDownloader.js';
import { extractMediaType, extractQuotedRaw } from '../core/message.js';

const run = promisify(execFile);

/** Cheap cached probe — do not shell out on every command. */
let ffmpegAvailable = null;
async function hasFfmpeg() {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await run('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

/** Current caption media, or an explicitly replied-to media message. */
function mediaSource(ctx, expectedType) {
  if (ctx.msg?.media?.type === expectedType) return { raw: ctx.msg.raw, media: ctx.msg.media };
  const quoted = extractQuotedRaw(ctx.msg?.raw);
  const media = quoted ? extractMediaType(quoted.message) : null;
  return media?.type === expectedType ? { raw: quoted, media } : null;
}

export default {
  category: 'media',
  commands: [
    {
      name: 'sticker',
      aliases: ['s', 'stick'],
      description: 'Turn an attached image into a WebP sticker (put the command in its caption)',
      usage: '.sticker (image caption)',
      ownerOnly: false,
      async execute(ctx) {
        if (!ctx.msg.media || ctx.msg.media.type !== 'image') {
          return ctx.reply('Send an image with `.sticker` in its caption.');
        }
        if (!(await hasFfmpeg())) {
          return ctx.reply(
            '⚠️ `ffmpeg` is not installed on this host, so images cannot be converted.\n\n' +
              'Install it (`apt-get install ffmpeg`) or add it to the container image.'
          );
        }

        let buffer;
        try {
          buffer = await downloadWhatsAppMedia(ctx.socket, ctx.msg.raw, ctx.logger);
        } catch (err) {
          return ctx.reply(`⚠️ Could not download the image: ${err.message}`);
        }

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sticker-'));
        const input = path.join(tmp, 'in.jpg');
        const output = path.join(tmp, 'out.webp');
        try {
          fs.writeFileSync(input, buffer);
          // WhatsApp stickers: 512x512, transparent-capable WebP, ≤100 KB.
          await run('ffmpeg', [
            '-y', '-i', input,
            '-vf', "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0",
            '-c:v', 'libwebp', '-lossless', '0', '-compression_level', '6',
            '-q:v', '70', '-an', '-vsync', '0',
            output,
          ]);
          await ctx.send(ctx.jid, { sticker: fs.readFileSync(output) });
        } catch (err) {
          ctx.logger.error(`sticker conversion failed: ${err.message}`);
          await ctx.reply(`⚠️ Conversion failed: ${String(err.message).slice(0, 200)}`);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'archive',
      aliases: ['media'],
      description: 'List media the bot has archived to disk',
      usage: '.archive [count]',
      ownerOnly: true,
      async execute(ctx) {
        const store = ctx.bot?.mediaStore;
        if (!store) return ctx.reply('Media archive is not active in this mode.');

        const stats = store.stats();
        const rows = store.recent(Math.min(Number.parseInt(ctx.args[0], 10) || 10, 30));

        if (!rows.length) {
          return ctx.reply(`📦 Archive is empty.\n_dir: \`${stats.dir}\`_`);
        }

        const lines = [
          `📦 *Archived media (${stats.count})*`,
          `_total ${formatBytes(stats.bytes)} in \`${stats.dir}\`_`,
          '',
          ...rows.map((r) => {
            const who = r.sender_jid ? ctx.bot?.contacts?.displayName(r.sender_jid).name : 'unknown';
            const exists = fs.existsSync(r.path) ? '' : ' ⚠️missing';
            return `${mediaIcon(r.kind)} ${describeMedia(r)} · ${who} · ${formatBytes(r.bytes)} · ${timeAgo(r.archived_at)}${exists}`;
          }),
        ];
        await ctx.reply(lines.join('\n'));
      },
    },
    {
      name: 'transcribe',
      aliases: ['stt'],
      description: 'Transcribe audio in its caption or an audio message you reply to (needs an AI key)',
      usage: '.transcribe (audio caption or reply to audio)',
      ownerOnly: true,
      async execute(ctx) {
        const source = mediaSource(ctx, 'audio');
        if (!source) return ctx.reply('Put `.transcribe` in an audio caption, or reply to audio with `.transcribe`.');

        const ai = ctx.bot?.ai;
        if (!ai) return ctx.reply('The AI orchestrator is not active in this mode.');
        if (!ai.configured()) {
          return ctx.reply(
            '🎤 _Transcription needs an AI provider with audio support._\n\n' +
              'Set `GROQ_API_KEY` (Whisper) or `OPENAI_API_KEY` in `.env`.'
          );
        }

        let buffer;
        try {
          buffer = await downloadWhatsAppMedia(ctx.socket, source.raw, ctx.logger);
        } catch (err) {
          return ctx.reply(`⚠️ Could not download the audio: ${err.message}`);
        }

        try {
          const base64 = buffer.toString('base64');
          const mime = source.media.mimetype || 'audio/ogg';
          const text = await ai.transcribeAudio({ base64, mime });
          await ctx.reply(`🎤 *Transcript*\n\n${text}`);
        } catch (err) {
          await ctx.reply(`⚠️ Transcription failed: ${String(err.message).slice(0, 200)}`);
        }
      },
    },
  ],
};
