/**
 * Nexus-WA — view-once capture.
 *
 * When the linked-device session receives the media payload, it is fetched
 * immediately and copied to the account's self-chat. Some companion profiles
 * receive only Baileys' `key.isViewOnce` unavailable marker, with no media
 * payload; those events are recorded and reported, but the missing media cannot
 * be reconstructed by this process.
 *
 * The linked-device session is independent of the handset's power and network
 * state. There are two important limits:
 *   • If the bot process is down, the media URL may be expired by the time
 *     WhatsApp redelivers the event after reconnect. We report that as expired.
 *   • If WhatsApp sends only an unavailable marker for this companion profile,
 *     no media bytes exist in the event to download. We report that separately.
 * In both cases the event is persisted and an alert is attempted when the
 * linked socket has a self-JID.
 *
 * Timing matters: the media is fetched the moment the message arrives, before
 * anything else touches it, because WhatsApp invalidates view-once blobs once
 * they have been "seen".
 */

import { normalizeJid, isGroupJid, describeChat } from './jid.js';
import { flag, setFlag } from '../database/index.js';
import { describeMedia, mediaIcon } from '../lib/media.js';

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export class ViewOnceCapture {
  /**
   * @param {object} deps
   * @param {object} deps.socket
   * @param {object} deps.db
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
    if (!msg?.viewOnce) return null;
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

    // Fetch IMMEDIATELY — the blob is invalidated once the message is seen.
    //
    // If the envelope carried no media payload at all, do not attempt a
    // download: there is nothing to fetch, and letting it fail would record
    // the event as "expired", which tells the owner the wrong thing.
    let buffer = null;
    if (!msg.media) {
      // Baileys v7 marks a server-side unavailable view-once message on the
      // message key, without a media envelope. Do not mislabel this as an
      // expired download: no payload was delivered to this linked device.
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
        buffer = this.downloader
          ? await this.downloader(raw)
          : await this.socket.downloadMediaMessage(raw);
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

  #persist(r) {
    try {
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
          this.selfJid() || '',
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
    const self = this.selfJid();
    if (!self) {
      this.logger.warn('no self JID — nowhere to send the view-once alert');
      return;
    }

    const text = formatViewOnce(record);
    await this.socket.sendMessage(self, { text });

    if (!buffer?.length) return;
    try {
      const label = `${mediaIcon(record.kind)} view-once ${describeMedia(record)}`;
      if (record.kind === 'image') await this.socket.sendMessage(self, { image: buffer, caption: label });
      else if (record.kind === 'video') await this.socket.sendMessage(self, { video: buffer, caption: label });
      else if (record.kind === 'sticker') await this.socket.sendMessage(self, { sticker: buffer });
      else if (record.kind === 'audio')
        await this.socket.sendMessage(self, {
          audio: buffer,
          mimetype: record.mimetype || 'audio/ogg',
          ptt: /ogg|opus/i.test(record.mimetype || ''),
        });
      else
        await this.socket.sendMessage(self, {
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

  const who = [p.name, p.phoneE164 && p.phoneE164 !== p.name ? p.phoneE164 : null]
    .filter(Boolean)
    .join(' · ');
  lines.push(`👤 ${who || 'unknown sender'}`);

  const meta = [
    p.countryName,
    r.isGroup ? r.chatLabel : null,
    clockTime(r.at),
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
      r.caption ? `> ${r.caption}` : ''
    );
  } else {
    lines.push('_No media bytes were returned._');
  }

  return lines.filter((l) => l !== undefined).join('\n');
}

export default ViewOnceCapture;
