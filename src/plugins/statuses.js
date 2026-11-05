/**
 * `.status` — statuses the bot received while it was online.
 *
 * `.status` lists them newest first, numbered. Typing a number in the same
 * chat sends that status there. Statuses are never viewed or marked as read.
 * WhatsApp only delivers statuses live, so older ones cannot be fetched.
 */

import { downloadWhatsAppMedia } from '../core/mediaDownloader.js';
import { unwrap } from '../core/message.js';
import { jidToPhone } from '../core/jid.js';
import { dateTime12, DEFAULT_TZ, senderLine } from '../lib/display.js';

const DEFAULT_LIST = 20;
const MAX_LIST = 50;
const PICK_TTL_MS = 30 * 60_000;

const KIND_LABEL = {
  image: 'photo',
  video: 'video',
  audio: 'voice note',
  sticker: 'sticker',
  document: 'document',
  text: 'text',
};

function whoLine(jid, contacts) {
  let profile = null;
  try {
    profile = contacts?.profile?.(jid) || null;
  } catch {
    profile = null;
  }
  const named = senderLine(profile);
  if (named && named !== '') return named;
  const phone = jidToPhone(jid);
  return phone ? `+${phone}` : 'Unknown';
}

function excerpt(text, max = 60) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function renderList(rows, contacts, tz) {
  const lines = rows.map((row, i) => {
    const kind = KIND_LABEL[row.kind] || row.kind || 'text';
    const note = row.text ? ` — ${excerpt(row.text)}` : '';
    return `Status ${i + 1}: ${whoLine(row.poster_jid, contacts)} · ${dateTime12(row.ts, tz)} · ${kind}${note}`;
  });
  return [
    '*Statuses received while online* (newest first)',
    '',
    ...lines,
    '',
    'Type a number to send that status to this chat.',
  ].join('\n');
}

/** Send one stored status into a chat. Media is downloaded fresh; it may have expired. */
async function sendStatus({ socket, chatJid, row, contacts, tz, logger }) {
  const who = whoLine(row.poster_jid, contacts);
  const header = `Status from ${who} · ${dateTime12(row.ts, tz)}`;
  const caption = row.text ? `${header}\n\n${row.text}` : header;

  if (!row.has_media) {
    return socket.sendMessage(chatJid, { text: caption });
  }

  const buffer = await downloadWhatsAppMedia(socket, row.raw, logger);
  const { inner } = unwrap(row.raw?.message || {});
  if (inner?.imageMessage) {
    return socket.sendMessage(chatJid, { image: buffer, caption });
  }
  if (inner?.videoMessage) {
    return socket.sendMessage(chatJid, { video: buffer, caption });
  }
  if (inner?.audioMessage) {
    await socket.sendMessage(chatJid, {
      audio: buffer,
      mimetype: inner.audioMessage.mimetype || 'audio/ogg; codecs=opus',
      ptt: false,
    });
    return socket.sendMessage(chatJid, { text: header });
  }
  if (inner?.stickerMessage) {
    await socket.sendMessage(chatJid, { sticker: buffer });
    return socket.sendMessage(chatJid, { text: header });
  }
  if (inner?.documentMessage) {
    return socket.sendMessage(chatJid, {
      document: buffer,
      mimetype: inner.documentMessage.mimetype || 'application/octet-stream',
      fileName: inner.documentMessage.fileName || 'status',
      caption,
    });
  }
  return socket.sendMessage(chatJid, { text: caption });
}

/** Arm the number picker for this chat. Re-armed after each pick, so the owner can pick several. */
function armPicker(prompts, chatJid, ids, deps) {
  prompts.set(
    chatJid,
    {
      kind: 'status-pick',
      ownerOnly: true,
      onReply: ({ text, socket, reply }) => onPick({ text, socket, reply, prompts, chatJid, ids, ...deps }),
    },
    { ttlMs: PICK_TTL_MS }
  );
}

async function onPick({ text, socket, reply, prompts, chatJid, ids, feed, contacts, tz, logger }) {
  const choice = String(text || '').trim();
  if (!/^\d{1,3}$/.test(choice)) {
    armPicker(prompts, chatJid, ids, { feed, contacts, tz, logger });
    return reply('Type a status number from the list, or send any other command to stop.');
  }
  const index = Number(choice);
  if (index < 1 || index > ids.length) {
    armPicker(prompts, chatJid, ids, { feed, contacts, tz, logger });
    return reply(`No status ${index} in the list. Pick 1–${ids.length}.`);
  }

  const row = feed.get(ids[index - 1]);
  armPicker(prompts, chatJid, ids, { feed, contacts, tz, logger });
  if (!row) return reply('That status is no longer stored.');

  try {
    await sendStatus({ socket, chatJid, row, contacts, tz, logger });
  } catch (err) {
    logger?.warn?.({ err: err.message }, 'status send failed');
    return reply('Could not send that status. Its media has probably expired, since WhatsApp removes statuses after 24 hours.');
  }
}

export default {
  name: 'status',
  aliases: ['statuses'],
  category: 'privacy',
  description: 'List statuses received while online, then type a number to send one here',
  usage: '.status [count]',
  ownerOnly: true,

  async execute(ctx) {
    const feed = ctx.bot?.statusFeed;
    if (!feed) return ctx.reply('Status capture is not active in this mode.');

    const requested = Number(ctx.args?.[0] ?? DEFAULT_LIST);
    if (!Number.isInteger(requested) || requested < 1) {
      return ctx.reply(`usage: .status [count], count 1–${MAX_LIST}`);
    }
    const limit = Math.min(requested, MAX_LIST);
    const rows = feed.list(limit);
    if (!rows.length) {
      return ctx.reply('No statuses received yet. The bot only sees statuses while it is online.');
    }

    const contacts = ctx.bot?.contacts;
    const tz = ctx.config?.scheduler?.timezone || DEFAULT_TZ;
    const prompts = ctx.bot?.prompts;
    if (prompts) {
      armPicker(prompts, ctx.jid, rows.map((r) => r.id), {
        feed,
        contacts,
        tz,
        logger: ctx.logger,
      });
    }
    return ctx.reply(renderList(rows, contacts, tz));
  },
};
