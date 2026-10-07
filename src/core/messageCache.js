/**
 * Nexus-WA — message cache.
 *
 * WhatsApp's revoke event tells you ONLY the stanza id of the deleted message.
 * It never repeats the content. So to tell you what was deleted, the content
 * has to have been captured on the way in.
 *
 * Two tiers, on purpose:
 *   • SQLite `message_cache` — durable. Survives restarts, so a message
 *     deleted 3 hours after a redeploy still resolves to its text.
 *   • in-memory raw map — volatile, TTL'd. Holds the ORIGINAL Baileys object,
 *     which is the only thing `downloadMediaMessage()` can work from. That is
 *     what lets us forward the actual deleted photo/video/voice note.
 *
 * The honest consequence: text survives restarts; media only survives as long
 * as the process does (and as long as WhatsApp still serves the blob).
 */

import { normalizeJid } from './jid.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RAW = 1000;

export class MessageCache {
  /**
   * @param {object} db
   * @param {object} logger
   * @param {object} [opts]
   * @param {number} [opts.ttlMs]
   * @param {number} [opts.maxRaw]
   */
  constructor(db, logger, { ttlMs = DEFAULT_TTL_MS, maxRaw = DEFAULT_MAX_RAW } = {}) {
    this.db = db;
    this.logger = logger.child({ scope: 'cache' });
    this.ttlMs = ttlMs;
    this.maxRaw = maxRaw;
    /** @type {Map<string, object>} stanzaId -> raw Baileys message */
    this.raw = new Map();
    this.stats = { stored: 0, hits: 0, misses: 0, pruned: 0 };
  }

  /**
   * @param {object} raw     original Baileys message
   * @param {object} msg     normalised message (core/message.js)
   * @param {string} sessionJid
   */
  store(raw, msg, sessionJid) {
    if (!msg?.id) return;
    if (msg.isBot) return; // our own messages are not interesting here

    const kind = msg.media?.type || (msg.text ? 'text' : 'unknown');

    this.db
      .prepare(
        `INSERT INTO message_cache
           (id, session_jid, chat_jid, sender_jid, kind, text, media_mimetype,
            media_seconds, media_bytes, has_media, view_once, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           kind = excluded.kind`
      )
      .run(
        msg.id,
        normalizeJid(sessionJid),
        normalizeJid(msg.jid),
        normalizeJid(msg.sender),
        kind,
        msg.text || null,
        msg.media?.mimetype || null,
        msg.media?.seconds ?? null,
        msg.media?.payload?.fileLength ?? null,
        msg.media ? 1 : 0,
        msg.viewOnce ? 1 : 0,
        msg.timestamp * 1000
      );

    this.#rememberRaw(msg.id, raw);
    this.stats.stored++;
  }

  #rememberRaw(id, raw) {
    this.raw.set(id, { raw, at: Date.now() });
    // Evict oldest once over budget. Map preserves insertion order.
    while (this.raw.size > this.maxRaw) {
      const oldest = this.raw.keys().next().value;
      this.raw.delete(oldest);
      this.stats.pruned++;
    }
  }

  /** Structured record for a stanza id, from the durable tier. */
  getRecord(id) {
    const row = this.db.prepare('SELECT * FROM message_cache WHERE id = ?').get(id);
    if (row) this.stats.hits++;
    else this.stats.misses++;
    return row || null;
  }

  /** The original Baileys object, if still in memory and unexpired. */
  getRaw(id) {
    const hit = this.raw.get(id);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.raw.delete(id);
      return null;
    }
    return hit.raw;
  }

  /**
   * Everything we can recover about a deleted message.
   * @returns {{known:boolean, record:object|null, raw:object|null, mediaAvailable:boolean}}
   */
  resolveDeleted(id) {
    const record = this.getRecord(id);
    const raw = this.getRaw(id);
    return {
      known: Boolean(record || raw),
      record,
      raw,
      mediaAvailable: Boolean(raw && record?.has_media),
    };
  }

  /** Drop cache rows older than the TTL. Returns rows removed. */
  prune(now = Date.now()) {
    const res = this.db
      .prepare('DELETE FROM message_cache WHERE ts < ?')
      .run(now - this.ttlMs);
    for (const [id, hit] of this.raw) {
      if (now - hit.at > this.ttlMs) this.raw.delete(id);
    }
    return res.changes || 0;
  }

  size() {
    return {
      raw: this.raw.size,
      rows: this.db.prepare('SELECT COUNT(*) AS n FROM message_cache').get().n,
    };
  }
}

export default MessageCache;
