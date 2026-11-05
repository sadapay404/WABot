/**
 * Nexus-WA — anti-delete ("who deleted what").
 *
 * WhatsApp tells you a message was revoked, but never what it said. This
 * service joins that revoke event against the message cache and pushes the
 * recovered content to your own chat — the one with yourself, which only you
 * can read.
 *
 * Your original spec, implemented:
 *   "(Phone number), (Name saved on my device) Deleted a message (content)"
 *   …and for photo / video / voice, the media is forwarded separately.
 *
 * Revokes arrive in three different shapes depending on who deleted what:
 *   1. messages.update  → update.message.protocolMessage { type: REVOKE, stanzaId }
 *   2. messages.upsert  → message.protocolMessage { type: REVOKE, stanzaId }
 *   3. messageStubType  → REVOKE / ADMIN_REVOKE (a group admin removing yours)
 * `extractRevoke()` handles all three and is unit-tested on its own.
 */

import { normalizeJid, isGroupJid, isStatusBroadcast, describeChat } from './jid.js';
import { alertContext } from '../lib/display.js';
import { captureAlertJid } from './alertRouting.js';
import { getSetting, setSetting } from '../database/index.js';
import { downloadWhatsAppMedia } from './mediaDownloader.js';

/** WAProto.Message.ProtocolMessage.Type.REVOKE */
const PROTOCOL_REVOKE = 0;
/** WAMessageStubType — verified against baileys 7.0.0-rc14. */
const STUB_REVOKE = 1;
const STUB_ADMIN_REVOKE = 132;

function firstAddress(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

/** Protocol revisions call the parallel phone/LID field either *Alt or *Pn. */
function actorAlternate(key, hasParticipant) {
  return key?.fromMe
    ? firstAddress(key.remoteJidAlt, key.remoteJidPn, key.remoteJidPN)
    : hasParticipant
      ? firstAddress(key.participantAlt, key.participantPn, key.participantPN)
      : firstAddress(key.remoteJidAlt, key.remoteJidPn, key.remoteJidPN);
}

/**
 * Pull the revoked stanza id out of any of the three shapes.
 * @returns {string|null}
 */
export function extractRevoke(payload = {}) {
  const update = payload.update || {};
  const message = update.message || payload.message || null;

  const proto = message?.protocolMessage;
  if (proto && (proto.type === PROTOCOL_REVOKE || proto.type === 'REVOKE')) {
    // `stanzaId` is the deleted message; `key.id` is the revoke itself.
    return proto.stanzaId || null;
  }

  // Nested one level deeper in some builds.
  const inner = message?.protocolMessage?.protocolMessage;
  if (inner?.stanzaId) return inner.stanzaId;

  const stub = update.messageStubType ?? payload.messageStubType;
  const isRevoke =
    stub === 'REVOKE' || stub === STUB_REVOKE || stub === 'ADMIN_REVOKE' || stub === STUB_ADMIN_REVOKE;
  if (isRevoke) {
    // Stub events carry no stanza id — we can only report that it happened.
    return payload.key?.id || null;
  }

  return null;
}

const MEDIA_LABEL = {
  image: 'photo',
  video: 'video',
  audio: 'audio',
  document: 'document',
  sticker: 'sticker',
};

/** Voice notes and uploaded audio look identical except for the mimetype. */
function describeMedia(record) {
  const kind = record?.kind;
  if (kind === 'audio') {
    const mime = record?.media_mimetype || '';
    return /ogg|opus/i.test(mime) ? 'voice note' : 'audio file';
  }
  return MEDIA_LABEL[kind] || kind || 'message';
}


export class AntiDelete {
  /**
   * @param {object} deps
   * @param {object} deps.socket     real or mock socket
   * @param {object} deps.db
   * @param {import('./messageCache.js').MessageCache} deps.cache
   * @param {import('./contactStore.js').ContactStore} deps.contacts
   * @param {import('./sessionRegistry.js').SessionRegistry} deps.registry
   * @param {object} deps.logger
   * @param {object} deps.config
   * @param {Function} [deps.downloader]  (rawMessage) => Buffer
   * @param {string}   [deps.selfJid]     override for tests / dry-run
   */
  constructor({
    socket,
    db,
    cache,
    contacts,
    registry,
    logger,
    config,
    downloader = null,
    selfJid = null,
  }) {
    this.socket = socket;
    this.db = db;
    this.cache = cache;
    this.contacts = contacts;
    this.registry = registry;
    this.logger = logger.child({ scope: 'anti-delete' });
    this.config = config;
    this.downloader = downloader;
    this.selfOverride = selfJid;
    // A revoke can be emitted in both messages.upsert and messages.update;
    // protect the short overlap before its durable row is written.
    this.inFlight = new Set();
    this.stats = { detected: 0, resolved: 0, unresolved: 0, mediaForwarded: 0, failed: 0 };
  }

  /** The chat with yourself — only you can read it. */
  selfJid() {
    if (this.selfOverride) return normalizeJid(this.selfOverride);
    const me = this.socket?.user?.id;
    return me ? normalizeJid(me) : null;
  }

  enabled() {
    return getSetting(this.db, 'antidelete.enabled', 'true') === 'true';
  }

  setEnabled(on) {
    setSetting(this.db, 'antidelete.enabled', on ? 'true' : 'false');
    this.logger.info(`anti-delete ${on ? 'ENABLED' : 'DISABLED'}`);
    return this.enabled();
  }

  forwardMedia() {
    return getSetting(this.db, 'antidelete.forwardMedia', 'true') === 'true';
  }

  setForwardMedia(on) {
    setSetting(this.db, 'antidelete.forwardMedia', on ? 'true' : 'false');
    return this.forwardMedia();
  }

  // ── Event entry points ───────────────────────────────────────────

  /** Every inbound message: cache it so a later revoke can be resolved. */
  onMessage(raw, msg) {
    try {
      this.cache.store(raw, msg, this.selfJid() || '');
      const revoked = extractRevoke(raw);
      if (revoked) return this.onRevoke(raw, revoked);
    } catch (err) {
      this.stats.failed++;
      this.logger.error(`cache failure: ${err.message}`);
    }
  }

  /** messages.update stream. */
  onUpdate(update) {
    const revoked = extractRevoke(update);
    if (!revoked) return;
    return this.onRevoke(update, revoked);
  }

  /** The heart of it: resolve a revoke and notify. */
  async onRevoke(source, stanzaId) {
    if (!this.enabled()) return null;

    const key = source?.key || {};
    const chatJid = normalizeJid(key.remoteJid);
    const sessionJid = this.selfJid() || '';
    const id = String(stanzaId || '').trim();
    if (!id || !chatJid) return null;
    const dedupeKey = `${sessionJid}\u0000${chatJid}\u0000${id}`;
    if (this.inFlight.has(dedupeKey) || this.#alreadyRecorded(id, sessionJid, chatJid)) return null;

    this.inFlight.add(dedupeKey);
    try {
      this.stats.detected++;
      const isGroup = isGroupJid(chatJid);
      const isStatus = isStatusBroadcast(chatJid);
      const { known, record, raw, mediaAvailable } = this.cache.resolveDeleted(stanzaId);
      if (!known) this.stats.unresolved++;
      else this.stats.resolved++;

      // Revoke stanzas are sparse. For a status broadcast (and for an older
      // group revoke without participant) the cached original is the reliable
      // source of the human sender, never the status/group address itself.
      const senderJid = normalizeJid(
        key.fromMe
          ? this.selfJid()
          : (isGroup || isStatus)
            ? key.participant || raw?.key?.participant || record?.sender_jid || chatJid
            : record?.sender_jid || chatJid
      );
      const senderAlt = actorAlternate(key, isGroup || isStatus);

      // Don't report your own deletions back to you — you know you did it.
      const deletedByOther = !key.fromMe;

      // If this revoke has both forms, profile() stores the observed relationship
      // before rendering. Existing aliases still resolve when a revoke carries
      // only an LID.
      const profile = this.contacts.profile(senderJid, senderAlt);
      const chatLabel = describeChat(chatJid, {
        myJid: this.selfJid(),
        name: isGroupJid(chatJid) ? null : profile.name,
      });

      const deletion = {
        stanzaId,
        chatJid,
        chatLabel,
        isGroup: isGroupJid(chatJid),
        senderJid,
        profile,
        record,
        known,
        mediaAvailable,
        deletedByOther,
        at: Date.now(),
      };

      this.#persist(deletion);
      const text = formatDeletion(deletion);
      await this.#deliver(text, deletion, raw);
      return deletion;
    } finally {
      this.inFlight.delete(dedupeKey);
    }
  }

  #alreadyRecorded(stanzaId, sessionJid, chatJid) {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM deleted_messages WHERE stanza_id = ? AND session_jid = ? AND chat_jid = ? LIMIT 1')
        .get(stanzaId, sessionJid, chatJid)
    );
  }

  #persist(d) {
    try {
      this.db
        .prepare(
          `INSERT INTO deleted_messages
             (stanza_id, session_jid, chat_jid, sender_jid, sender_name, sender_phone,
              sender_country, kind, content, deleted_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          d.stanzaId,
          this.selfJid() || '',
          d.chatJid,
          d.senderJid,
          d.profile.name,
          d.profile.phoneE164,
          d.profile.countryName,
          d.record?.kind || 'unknown',
          d.record?.text || null,
          d.at
        );
      this.registry?.countDeletion(this.selfJid() || d.chatJid, 1);
    } catch (err) {
      this.logger.error(`could not persist deletion: ${err.message}`);
    }
  }

  async #deliver(text, deletion, raw) {
    const destination = captureAlertJid(this.config, this.selfJid());
    if (!destination) {
      this.logger.warn('no capture-alert destination resolved — nowhere to send the alert');
      return;
    }

    const alert = await this.socket.sendMessage(destination, { text });

    // Forward the actual deleted media when we still hold the original object.
    // Quote the alert itself, not the unrelated revoke, so WhatsApp renders a
    // clean alert → recovered-media thread in the owner's capture chat.
    if (!deletion.mediaAvailable || !this.forwardMedia()) return;
    const replyOptions = alert?.key ? { quoted: alert } : {};
    try {
      const buffer = this.downloader
        ? await this.downloader(raw)
        : await downloadWhatsAppMedia(this.socket, raw, this.logger);
      if (!buffer?.length) return;

      const kind = deletion.record?.kind;
      const mime = deletion.record?.media_mimetype || 'application/octet-stream';
      const caption = `↳ Recovered deleted ${describeMedia(deletion.record)}`;

      if (kind === 'image') await this.socket.sendMessage(destination, { image: buffer, caption }, replyOptions);
      else if (kind === 'video') await this.socket.sendMessage(destination, { video: buffer, caption }, replyOptions);
      else if (kind === 'sticker') await this.socket.sendMessage(destination, { sticker: buffer }, replyOptions);
      else if (kind === 'audio')
        await this.socket.sendMessage(destination, {
          audio: buffer,
          mimetype: mime,
          ptt: /ogg|opus/i.test(mime),
        }, replyOptions);
      else await this.socket.sendMessage(destination, { document: buffer, mimetype: mime, fileName: 'deleted' }, replyOptions);

      this.stats.mediaForwarded++;
    } catch (err) {
      // Media expiring server-side is normal and not worth alarming you about.
      this.logger.warn(`could not forward deleted media: ${err.message}`);
    }
  }

  recent(limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM deleted_messages ORDER BY deleted_at DESC LIMIT ?`
      )
      .all(limit);
  }
}

/**
 * Build the notification text. Pure and exported so it can be asserted on
 * without a socket, a database or a WhatsApp account.
 */
export function formatDeletion(d) {
  const kindLabel = d.record?.has_media ? describeMedia(d.record) : 'message';
  const lines = [`🗑️ *Deleted ${kindLabel}*`, ''];

  lines.push(...alertContext(d.profile, {
    chatJid: d.chatJid,
    chatLabel: d.chatLabel,
    at: d.at,
  }));
  lines.push('');

  if (!d.known || (!d.record?.text && !d.record?.has_media)) {
    lines.push('_No recoverable content was retained for this message._');
  } else if (d.record?.text) {
    lines.push('*Deleted content*');
    // Quote each line so it reads as the deleted message, not our own words.
    for (const line of String(d.record.text).split('\n')) lines.push(`> ${line}`);
  } else if (d.mediaAvailable) {
    lines.push(`_A recovered ${describeMedia(d.record)} is attached in reply to this alert._`);
  } else {
    lines.push(`_The deleted ${describeMedia(d.record)} is no longer available to recover._`);
  }

  return lines.join('\n');
}

export default AntiDelete;
export { describeMedia };
