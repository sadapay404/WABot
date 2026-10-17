/**
 * Nexus-WA — view-once capture.
 *
 * When the linked-device session receives the media payload, it is fetched
 * immediately and copied to the account's self-chat. Some companion profiles
 * receive only Baileys' `key.isViewOnce` unavailable marker, with no media
 * payload; those events are recorded and reported, but the missing media cannot
 * be reconstructed by this process.
 *
 * If the primary phone later replies with `*`, 🤔, or 👀 to the original, the
 * quotedMessage can carry the media key/url. That owner-triggered fallback is
 * handled separately; the bot never downloads arbitrary quoted media.
 *
 * Timing matters: the media is fetched the moment it arrives, before anything
 * else touches it, because WhatsApp can invalidate short-lived media URLs.
 */

import { normalizeJid, isGroupJid, describeChat } from './jid.js';
import { captureAlertJid } from './alertRouting.js';
import { normalize, unwrap } from './message.js';
import { flag, setFlag } from '../database/index.js';
import { describeMedia, mediaIcon } from '../lib/media.js';
import { chatTag, dateTime12, senderLine } from '../lib/display.js';

const VIEW_ONCE_RECOVERY_REPLIES = new Set(['*', '🤔', '👀']);


export class ViewOnceCapture {
  /**
   * @param {object} deps
   * @param {object} deps.socket
   * @param {object} deps.db
   * @param {import('./messageCache.js').MessageCache} [deps.cache]
   * @param {import('./contactStore.js').ContactStore} deps.contacts
   * @param {import('./sessionRegistry.js').SessionRegistry} deps.registry
   * @param {import('./mediaStore.js').MediaStore} deps.mediaStore
   * @param {object} deps.logger
   * @param {object} deps.config
   * @param {Function} [deps.downloader]   (rawMessage) => Buffer
   * @param {Function} [deps.onCaptured]   hook for webhooks/audit
   */
  constructor({
    socket,
    db,
    cache = null,
    contacts,
    registry,
    mediaStore,
    logger,
    config,
    downloader = null,
    onCaptured = null,
  }) {
    this.socket = socket;
    this.db = db;
    this.cache = cache;
    this.contacts = contacts;
    this.registry = registry;
    this.mediaStore = mediaStore;
    this.logger = logger.child({ scope: 'view-once' });
    this.config = config;
    this.downloader = downloader;
    this.onCaptured = onCaptured;
    this.stats = {
      detected: 0,
      captured: 0,
      expired: 0,
      empty: 0,
      unavailable: 0,
      forwarded: 0,
      failed: 0,
    };
  }

  selfJid() {
    const me = this.socket?.user?.id;
    return me ? normalizeJid(me) : null;
  }

  enabled() {
    return flag(this.db, 'viewonce.enabled', true);
  }

  setEnabled(on) {
    setFlag(this.db, 'viewonce.enabled', on);
    this.logger.info(`view-once capture ${on ? 'ENABLED' : 'DISABLED'}`);
    return this.enabled();
  }

  /**
   * Called from the messages.upsert path, ahead of command dispatch.
   * @returns {Promise<object|null>} the persisted record
   */
  async onMessage(raw, msg) {
    if (!msg?.viewOnce) return this.#recoverQuotedReply(raw, msg);
    if (!this.enabled()) {
      this.stats.detected++;
      return null;
    }

    this.stats.detected++;
    const at = Date.now();
    const profile = this.contacts.profile(msg.sender);
    const kind = msg.media?.type || 'unknown';
    const mimetype = msg.media?.mimetype || null;
    const chatLabel = describeChat(msg.jid, { myJid: this.selfJid() });

    const record = {
      stanzaId: msg.id,
      chatJid: normalizeJid(msg.jid),
      chatLabel,
      isGroup: isGroupJid(msg.jid),
      senderJid: normalizeJid(msg.sender),
      profile,
      kind,
      mimetype,
      caption: msg.text || null,
      at,
      mediaPath: null,
      mediaBytes: 0,
      status: 'pending',
      error: null,
    };

    // Fetch immediately while WhatsApp still serves the media URL.
    let buffer = null;
    if (!msg.media) {
      const withheld = raw?.key?.isViewOnce === true;
      record.status = withheld ? 'unavailable' : 'empty';
      record.error = withheld
        ? 'Baileys received an unavailable view-once marker without media'
        : 'view-once message carried no media payload';
      this.stats[withheld ? 'unavailable' : 'empty']++;
      this.logger.warn(
        withheld
          ? `view-once ${msg.id} was marked unavailable; WhatsApp supplied no media payload`
          : `view-once ${msg.id} had no media payload`
      );
    } else {
      try {
        buffer = await this.#download(raw);
      } catch (err) {
        record.status = 'expired';
        record.error = err.message;
        this.stats.expired++;
        this.logger.warn(`media unavailable for view-once ${msg.id}: ${err.message}`);
      }
    }

    if (buffer?.length) {
      record.status = 'captured';
      record.mediaBytes = buffer.length;
      this.stats.captured++;
      this.logger.info(`view-once media captured (${record.mediaBytes} bytes)`);
      const saved = this.mediaStore?.save({
        buffer,
        kind,
        stanzaId: msg.id,
        mimetype,
        senderJid: record.senderJid,
        chatJid: record.chatJid,
      });
      if (saved) record.mediaPath = saved.path;
    } else if (record.status === 'pending') {
      record.status = 'empty';
      this.stats.failed++;
    }

    this.#persist(record);
    await this.#deliver(record, buffer);
    this.onCaptured?.(record);
    return record;
  }

  async #download(raw) {
    if (this.downloader) return this.downloader(raw);

    // Baileys exposes downloadMediaMessage as a package utility, not as a
    // makeWASocket method. Pass the socket's supported media-reupload hook.
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    const context = { logger: this.logger };
    if (typeof this.socket?.updateMediaMessage === 'function') {
      context.reuploadRequest = (message) => this.socket.updateMediaMessage(message);
    }
    return downloadMediaMessage(raw, 'buffer', {}, context);
  }

  #quotedMessage(raw) {
    const { inner } = unwrap(raw?.message);
    const contextInfo =
      inner?.extendedTextMessage?.contextInfo ||
      inner?.imageMessage?.contextInfo ||
      inner?.videoMessage?.contextInfo ||
      inner?.audioMessage?.contextInfo ||
      inner?.documentMessage?.contextInfo ||
      inner?.stickerMessage?.contextInfo ||
      null;
    if (!contextInfo?.stanzaId || !contextInfo.quotedMessage) return null;

    return {
      key: {
        remoteJid: contextInfo.remoteJid || raw.key?.remoteJid,
        remoteJidAlt: contextInfo.remoteJidAlt,
        id: contextInfo.stanzaId,
        fromMe: false,
        participant: contextInfo.participant || undefined,
        participantAlt: contextInfo.participantAlt || undefined,
      },
      message: contextInfo.quotedMessage,
      messageTimestamp: raw.messageTimestamp,
      pushName: raw.pushName,
    };
  }

  async #recoverQuotedReply(raw, msg) {
    // The phone's quotedMessage can carry the media key/url. Require an exact
    // owner-authored recovery token; never download arbitrary quoted media.
    const replyText = String(msg?.text || '').trim();
    if (!this.enabled() || raw?.key?.fromMe !== true || !VIEW_ONCE_RECOVERY_REPLIES.has(replyText)) return null;

    const quotedRaw = this.#quotedMessage(raw);
    if (!quotedRaw?.key?.id) return null;
    const quoted = normalize(quotedRaw);
    const markerRecord = this.cache?.getRecord?.(quotedRaw.key.id);
    const wasViewOnce = quoted.viewOnce || Number(markerRecord?.view_once) === 1;
    if (!wasViewOnce || !quoted.media) return null;

    const alreadyCaptured = this.db
      .prepare('SELECT 1 FROM view_once WHERE stanza_id = ? AND media_bytes > 0 LIMIT 1')
      .get(quotedRaw.key.id);
    if (alreadyCaptured) return null;

    this.logger.info('owner requested view-once recovery from a quoted phone reply');
    return this.onMessage(quotedRaw, { ...quoted, viewOnce: true });
  }

  #persist(r) {
    try {
      const sessionJid = this.selfJid() || '';
      const existing = this.db
        .prepare(
          'SELECT id, media_bytes FROM view_once WHERE stanza_id = ? AND session_jid = ? ORDER BY id DESC LIMIT 1'
        )
        .get(r.stanzaId, sessionJid);
      if (existing?.media_bytes > 0 && !r.mediaBytes) return;
      if (existing) {
        this.db
          .prepare(
            `UPDATE view_once SET chat_jid = ?, sender_jid = ?, sender_name = ?, sender_phone = ?,
               sender_country = ?, kind = ?, caption = ?, media_path = ?, media_bytes = ?,
               mimetype = ?, captured_at = ?, forwarded = 0 WHERE id = ?`
          )
          .run(
            r.chatJid,
            r.senderJid,
            r.profile.name,
            r.profile.phoneE164,
            r.profile.countryName,
            r.kind,
            r.caption,
            r.mediaPath,
            r.mediaBytes,
            r.mimetype,
            r.at,
            existing.id
          );
        return;
      }

      this.db
        .prepare(
          `INSERT INTO view_once
             (stanza_id, session_jid, chat_jid, sender_jid, sender_name, sender_phone,
              sender_country, kind, caption, media_path, media_bytes, mimetype,
              captured_at, forwarded)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
        )
        .run(
          r.stanzaId,
          sessionJid,
          r.chatJid,
          r.senderJid,
          r.profile.name,
          r.profile.phoneE164,
          r.profile.countryName,
          r.kind,
          r.caption,
          r.mediaPath,
          r.mediaBytes,
          r.mimetype,
          r.at
        );
    } catch (err) {
      this.logger.error(`could not persist view-once record: ${err.message}`);
    }
  }

  async #deliver(record, buffer) {
    const destination = captureAlertJid(this.config, this.selfJid());
    if (!destination) {
      this.logger.warn('no capture-alert destination — nowhere to send the view-once alert');
      return;
    }

    const text = formatViewOnce(record);
    await this.socket.sendMessage(destination, { text });

    if (!buffer?.length) return;
    try {
      const label = `${mediaIcon(record.kind)} view-once ${describeMedia(record)}`;
      if (record.kind === 'image') await this.socket.sendMessage(destination, { image: buffer, caption: label });
      else if (record.kind === 'video') await this.socket.sendMessage(destination, { video: buffer, caption: label });
      else if (record.kind === 'sticker') await this.socket.sendMessage(destination, { sticker: buffer });
      else if (record.kind === 'audio')
        await this.socket.sendMessage(destination, {
          audio: buffer,
          mimetype: record.mimetype || 'audio/ogg',
          ptt: /ogg|opus/i.test(record.mimetype || ''),
        });
      else
        await this.socket.sendMessage(destination, {
          document: buffer,
          mimetype: record.mimetype || 'application/octet-stream',
          fileName: `view-once-${record.stanzaId || 'unknown'}`,
        });

      this.stats.forwarded++;
      this.db
        .prepare('UPDATE view_once SET forwarded = 1 WHERE stanza_id = ?')
        .run(record.stanzaId);
    } catch (err) {
      this.stats.failed++;
      this.logger.error(`could not forward view-once media: ${err.message}`);
    }
  }

  recent(limit = 10) {
    return this.db.prepare('SELECT * FROM view_once ORDER BY captured_at DESC LIMIT ?').all(limit);
  }
}

/**
 * Build the notification. Pure and exported so it can be asserted on without
 * a socket, a database or a WhatsApp account.
 */
export function formatViewOnce(r) {
  const p = r.profile || {};
  const lines = [`${mediaIcon(r.kind)} *View-once ${describeMedia(r)}*`, ''];

  lines.push(`👤 ${senderLine(p)}`);

  const meta = [
    p.countryName,
    chatTag(r.chatJid, r.chatLabel),
    dateTime12(r.at),
    r.mediaBytes ? `${Math.round(r.mediaBytes / 1024)} KB` : null,
  ].filter(Boolean);
  if (meta.length) lines.push(`ℹ️ ${meta.join(' · ')}`);

  lines.push('');

  if (r.status === 'captured' && r.mediaBytes) {
    lines.push(r.caption ? `> ${r.caption}` : '_Saved below — it was set to disappear after one view._');
  } else if (r.status === 'expired') {
    lines.push(
      '⚠️ *Media expired before capture.*',
      r.caption ? `> ${r.caption}` : '',
      '',
      'The bot was not running when this arrived, and WhatsApp had already',
      'invalidated the blob. The event is still recorded so you know it happened.',
    );
  } else if (r.status === 'unavailable') {
    lines.push(
      '⚠️ *WhatsApp sent only the view-once marker; this linked device received no media to save.*',
      'If it is still available on the primary phone, reply with `*`, 🤔, or 👀 to the original there; the quoted copy may let the bot recover it.',
      r.caption ? `> ${r.caption}` : ''
    );
  } else {
    lines.push('_No media bytes were returned._');
  }

  return lines.filter((l) => l !== undefined).join('\n');
}

export default ViewOnceCapture;
