import { resolveRecipient } from '../core/scheduleWizard.js';
import { jidToPhone, normalizeJid } from '../core/jid.js';
import { describeMedia } from '../lib/media.js';

const DEFAULT_COUNT = 5;
const MAX_RECENT = 50;
const MAX_UNREAD = 100;
const MAX_UNREAD_CHATS = 50;
const MAX_MEDIA_FORWARD = 5;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_TEXT = 320;

const OTHER_TYPES = {
  contact: 'contact card',
  contacts: 'contact cards',
  location: 'location',
  live_location: 'live location',
  reaction: 'reaction',
  poll: 'poll',
  poll_vote: 'poll vote',
  event: 'event',
  group_invite: 'group invitation',
  interactive: 'interactive response',
  system: 'system message',
  unknown: 'other message',
};

function isControlChat(ctx) {
  const chat = normalizeJid(ctx.jid);
  const self = normalizeJid(ctx.bot?.selfJid);
  const owners = (ctx.config?.safety?.ownerJids || []).map(normalizeJid);
  return Boolean(chat && (chat === self || owners.includes(chat)));
}

function chatLabel(ctx, jid, alias = null) {
  const normalized = normalizeJid(jid);
  const primary = ctx.bot?.contacts?.displayName(normalized);
  const alternate = alias ? ctx.bot?.contacts?.displayName(alias) : null;
  const rawName = primary?.source !== 'jid'
    ? primary?.name
    : alternate?.source !== 'jid'
      ? alternate?.name
      : primary?.name || normalized;
  const phone = jidToPhone(normalized) || jidToPhone(alias);
  const name = phone && rawName === normalized ? `+${phone}` : rawName;
  return phone && !String(name).includes(phone) ? `${name} (+${phone})` : name;
}

function timestampLabel(epoch, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(epoch));
  } catch {
    return new Date(epoch).toISOString().slice(0, 16).replace('T', ' ');
  }
}

function messageType(record) {
  const kind = String(record?.kind || 'unknown');
  const label = ['image', 'video', 'audio', 'document', 'sticker'].includes(kind)
    ? describeMedia(record)
    : OTHER_TYPES[kind] || kind.replaceAll('_', ' ');
  return `${record?.view_once ? 'view-once ' : ''}${label}`;
}

function compact(value, max = MAX_TEXT) {
  const text = String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function describeRecord(record, index, timeZone) {
  const pieces = [`${index + 1}. ${timestampLabel(record.ts, timeZone)}`, messageType(record)];
  if (record.media_seconds != null && Number(record.media_seconds) > 0) {
    pieces.push(`${Math.floor(Number(record.media_seconds))} sec`);
  }
  if (record.media_bytes != null && Number(record.media_bytes) > 0) {
    const size = Number(record.media_bytes);
    pieces.push(size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`);
  }
  const lines = [`${pieces.join(' · ')}`];
  if (record.text) lines.push(`   ${compact(record.text)}`);
  else if (!record.has_media) lines.push('   _No readable text in the local cache._');
  return lines;
}

function mediaCaption(record, chatName, timeZone) {
  return `Received from ${chatName} · ${timestampLabel(record.ts, timeZone)} · ${messageType(record)}`;
}

function mediaContent(record, buffer, inbox, caption) {
  const mime = record.media_mimetype || 'application/octet-stream';
  const raw = inbox.cache?.getRaw?.(record.id);
  const inner = raw?.message || {};
  const filename = inner.documentMessage?.fileName || 'received-document';
  const safeFilename = String(filename).replace(/[\\/\0]/g, '_').slice(0, 100);
  switch (record.kind) {
    case 'image': return { image: buffer, caption };
    case 'video': return { video: buffer, caption };
    case 'audio': return { audio: buffer, mimetype: mime, ptt: /ogg|opus/i.test(mime) };
    case 'sticker': return { sticker: buffer };
    default: return { document: buffer, mimetype: mime, fileName: safeFilename, caption };
  }
}

function parseCount(value, fallback, maximum) {
  if (value == null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  return n >= 1 && n <= maximum ? n : null;
}

function usage() {
  return [
    '*Read-only message receiver*',
    '`.receive 03001234567 5` — latest 5 cached inbound messages from a direct chat',
    '`.recieve unread` — chats with a WhatsApp-synced unread count (cached previews are not individually verified unread)',
    'Unread mode never forwards media because WhatsApp does not identify unread message IDs. Add `--text-only` to any direct-chat lookup.',
    'Messages/media are sent only to this private owner control chat. The command does not call WhatsApp’s read-receipt API; blue-tick behavior is not guaranteed.',
  ].join('\n');
}

async function sendOwnerReport(ctx, text, attachments = []) {
  await ctx.reply(text);
  for (const item of attachments) {
    if (typeof ctx.send === 'function') await ctx.send(ctx.jid, item.content);
    else await ctx.socket.sendMessage(ctx.jid, item.content);
  }
}

async function retrieveAttachments(ctx, items, textOnly) {
  if (textOnly) return { attachments: [], unavailable: 0, capped: 0, tooLarge: 0 };
  const inbox = ctx.bot.messageInbox;
  const attachments = [];
  let unavailable = 0;
  let capped = 0;
  let tooLarge = 0;
  let attempted = 0;
  for (const item of items) {
    const record = item.record;
    if (!record.has_media) continue;
    if (Number(record.media_bytes) > MAX_MEDIA_BYTES) {
      tooLarge++;
      item.mediaNote = `_Media exceeds the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB per-file limit; it was not retrieved._`;
      continue;
    }
    if (attempted >= MAX_MEDIA_FORWARD) {
      capped++;
      continue;
    }
    attempted++;
    const buffer = await inbox.readMedia(record);
    if (!buffer?.length) {
      unavailable++;
      item.mediaNote = '_Media bytes are not available in the local cache/archive._';
      continue;
    }
    if (buffer.length > MAX_MEDIA_BYTES) {
      tooLarge++;
      item.mediaNote = `_Media exceeds the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB per-file limit; it was not attached._`;
      continue;
    }
    attachments.push({
      content: mediaContent(
        record,
        buffer,
        inbox,
        mediaCaption(record, item.chatLabel, ctx.config?.scheduler?.timezone || 'Asia/Karachi')
      ),
    });
    item.mediaNote = '_Media attached below._';
  }
  return { attachments, unavailable, capped, tooLarge };
}

function formatResults({ title, items, timeZone, unread = false, unknown = 0, omitted = 0, omittedMessages = 0, messageCap = MAX_UNREAD, media = {} }) {
  const lines = [title];
  if (unread) {
    lines.push('Unread status is chat-level and comes from WhatsApp’s synced unreadCount; cached messages are not individually identified as unread. The previews below are the latest locally cached inbound messages, not confirmed unread messages.');
    lines.push('Media is not attached in unread mode because WhatsApp did not identify the exact unread message IDs. Use `.receive <phone> <count>` to inspect a chat and available media explicitly.');
  }
  lines.push('');
  for (const item of items) {
    if (item.chatHeader) {
      lines.push(`*${item.chatLabel}* — WhatsApp reports ${item.unreadCount} unread message(s) in this chat; showing ${item.records.length} latest cached inbound preview(s), not individually marked unread.`);
    }
    const records = item.records || [item.record];
    let fallbackIndex = 0;
    for (const record of records) {
      const index = item.recordIndexes?.get(record.id) ?? fallbackIndex;
      lines.push(...describeRecord(record, index, timeZone));
      fallbackIndex++;
      const note = item.mediaNotes?.get(record.id);
      if (note) lines.push(`   ${note}`);
    }
    if (item.chatHeader && records.length === 0) {
      lines.push('   _No inbound message preview is currently cached for this chat._');
    }
    if (item.chatHeader) lines.push('');
  }
  if (unknown) {
    lines.push(`_${unknown} chat(s) have an unknown synced unread count and were not labeled unread._`);
  }
  if (omitted) lines.push(`_${omitted} unread chat(s) were beyond the ${MAX_UNREAD_CHATS}-chat report cap._`);
  if (omittedMessages) lines.push(`_WhatsApp reports ${omittedMessages} additional unread message(s) beyond this request’s ${messageCap}-message cap; individual message IDs were not available._`);
  if (media?.unavailable) lines.push(`_${media.unavailable} media item(s) could not be retrieved from local or temporary cache._`);
  if (media?.capped) lines.push(`_${media.capped} additional media item(s) omitted; at most ${MAX_MEDIA_FORWARD} are attached per request._`);
  if (media?.tooLarge) lines.push(`_${media.tooLarge} media item(s) were not fetched or attached because each exceeds the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB limit._`);
  if (media?.textOnly) lines.push('_Text-only mode: media was not opened or forwarded._');
  lines.push('', 'Read-only cache lookup; no sender chat was opened and no explicit read-receipt API was called.');
  return lines.join('\n');
}

export default {
  name: 'receive',
  aliases: ['recieve'],
  category: 'privacy',
  description: 'Inspect cached inbound messages without intentionally marking chats read',
  usage: '.receive <phone> [count] | .receive unread [max]',
  ownerOnly: true,
  privateOnly: true,
  async execute(ctx) {
    const inbox = ctx.bot?.messageInbox;
    if (!inbox) return ctx.reply('The read-only message inbox is not active in this mode.');
    if (!isControlChat(ctx)) {
      return ctx.reply('For privacy, use `.receive` only in your private controller chat or the linked account’s “You” chat.');
    }

    const args = [...(ctx.args || [])];
    const textOnly = args.some((arg) => ['--text-only', '--no-media'].includes(String(arg).toLowerCase()));
    const filtered = args.filter((arg) => !['--text-only', '--no-media'].includes(String(arg).toLowerCase()));
    const timeZone = ctx.config?.scheduler?.timezone || 'Asia/Karachi';

    if (String(filtered[0] || '').toLowerCase() === 'unread') {
      const cap = parseCount(filtered[1], MAX_UNREAD, MAX_UNREAD);
      if (!cap) return ctx.reply(usage());
      const totalUnreadChats = inbox.unreadChatCount();
      const states = inbox.unreadChats({ limit: MAX_UNREAD_CHATS });
      const selected = states;
      const items = [];
      let remaining = cap;
      let omittedMessages = 0;
      for (const [stateIndex, state] of selected.entries()) {
        const unreadCount = Number(state.unread_count);
        if (remaining <= 0) {
          omittedMessages += selected.slice(stateIndex).reduce((sum, row) => sum + Number(row.unread_count || 0), 0);
          break;
        }
        const amount = Math.min(unreadCount, remaining);
        if (amount <= 0) continue;
        remaining -= amount;
        omittedMessages += unreadCount - amount;
        const records = inbox.messages(state.chat_jid, { limit: amount });
        const label = chatLabel(ctx, state.chat_jid);
        items.push({
          chatHeader: true,
          chatLabel: label,
          unreadCount,
          records,
          recordIndexes: new Map(records.map((record, index) => [record.id, index])),
          missingCount: Math.max(0, amount - records.length),
        });
      }
      if (!items.length) {
        const unknown = inbox.unknownUnreadCount();
        return ctx.reply(unknown
          ? `No chats have a positive synced unread count. ${unknown} chat(s) have an unknown count; they were not treated as unread.`
          : 'WhatsApp has no positive synced unread counts available.');
      }

      const flat = items.flatMap((item) => item.records.map((record) => ({ record, chatLabel: item.chatLabel })));
      // A chat-level unread count does not tell us which cached message IDs are
      // unread. Keep unread previews text-only; explicit phone selection may
      // forward locally available media for inspection.
      const retrieved = await retrieveAttachments(ctx, flat, true);
      for (const item of items) {
        item.mediaNotes = new Map(flat
          .filter((row) => row.chatLabel === item.chatLabel && row.mediaNote)
          .map((row) => [row.record.id, row.mediaNote]));
      }
      const report = formatResults({
        title: `*Chats with synced unread counts — ${items.length} chat(s); ${flat.length} cached preview(s)*`,
        items,
        timeZone,
        unread: true,
        unknown: inbox.unknownUnreadCount(),
        omitted: Math.max(0, totalUnreadChats - selected.length),
        media: { ...retrieved, textOnly },
      });
      return sendOwnerReport(ctx, report, retrieved.attachments);
    }

    const requested = resolveRecipient(filtered[0], ctx.bot?.contacts);
    if (requested.status !== 'resolved' ||
        !(requested.jid.endsWith('@s.whatsapp.net') || requested.jid.endsWith('@lid'))) {
      return ctx.reply('Enter one direct WhatsApp phone number (Pakistani `03…` is accepted) or saved contact name.');
    }
    const count = parseCount(filtered[1], DEFAULT_COUNT, MAX_RECENT);
    if (!count) return ctx.reply(usage());
    const matches = inbox.findChats(requested.jid);
    if (!matches.length) return ctx.reply('No cached inbound messages were found for that direct chat.');
    if (matches.length > 1) {
      return ctx.reply('That number matches more than one cached chat identity. Use `.receive <full WhatsApp JID> <count>` to select the exact chat.');
    }

    const chat = matches[0];
    const records = inbox.messages(chat.chat_jid, { altJid: chat.chat_jid_alt, limit: count });
    if (!records.length) return ctx.reply('No cached inbound messages were found for that direct chat.');
    const label = chatLabel(ctx, chat.chat_jid, chat.chat_jid_alt);
    const items = records.map((record, index) => ({ record, chatLabel: label, index }));
    const retrieved = await retrieveAttachments(ctx, items, textOnly);
    const mediaNotes = new Map(items.filter((item) => item.mediaNote).map((item) => [item.record.id, item.mediaNote]));
    const reportItems = records.map((record, index) => ({
      record,
      chatLabel: label,
      recordIndexes: new Map([[record.id, index]]),
      mediaNotes,
    }));
    const report = formatResults({
      title: `*Last ${records.length} cached inbound message(s) — ${label}*`,
      items: reportItems,
      timeZone,
      media: { ...retrieved, textOnly },
    });
    return sendOwnerReport(ctx, report, retrieved.attachments);
  },
};
