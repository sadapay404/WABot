/**
 * Nexus-WA — message cache.
 *
 * WhatsApp's revoke event tells you ONLY the stanza id of the deleted message.
 * It never repeats the content. So to tell you what was deleted, the content
 * has to have been captured on the way in.
 *
 * Storage is split by purpose:
 *   • SQLite `message_cache` — inbound forensic records used by delete/edit
 *     recovery and search.
 *   • SQLite `conversation_cache` — text from both sides of one-to-one chats,
 *     used only when the owner explicitly asks AI about selected chats.
 *   • in-memory raw map — volatile, TTL'd. Holds the ORIGINAL Baileys object,
 *     which is the only thing `downloadMediaMessage()` can work from. That is
 *     what lets us forward the actual deleted photo/video/voice note.
 *
 * The honest consequence: captured text survives restarts; raw media access
 * only survives as long as the process and WhatsApp keep the blob available.
 */

import { normalizeJid } from './jid.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RAW = 1000;

/**
 * protobufjs can expose uint64 media sizes as Long objects. node:sqlite accepts
 * numbers, not those objects, so convert the value before binding it.
 */
function sqliteInteger(value) {
  if (value == null) return null;
  try {
    const n = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function addressSet(key, fields) {
  return new Set(
    fields
      .map((field) => key?.[field])
      .filter((jid) => typeof jid === 'string' && jid.length > 0)
      .map((jid) => normalizeJid(jid))
  );
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

/** Fail closed unless id, direction and chat (including known PN/LID aliases) agree. */
function matchesMessageKey(raw, requested) {
  if (
    !raw?.key ||
    typeof requested?.id !== 'string' ||
    !requested.id ||
    (!requested.remoteJid && !requested.remoteJidAlt) ||
    typeof requested.fromMe !== 'boolean'
  ) return false;
  if (
    raw.key.id !== requested.id ||
    typeof raw.key.fromMe !== 'boolean' ||
    raw.key.fromMe !== requested.fromMe
  ) return false;

  const requestedChats = addressSet(requested, ['remoteJid', 'remoteJidAlt']);
  const storedChats = addressSet(raw.key, ['remoteJid', 'remoteJidAlt']);
  if (!requestedChats.size || !intersects(requestedChats, storedChats)) return false;

  const isGroup = [...requestedChats].some((jid) => jid.endsWith('@g.us'));
  if (isGroup) {
    const requestedParticipants = addressSet(requested, ['participant', 'participantAlt']);
    const storedParticipants = addressSet(raw.key, ['participant', 'participantAlt']);
    if (requestedParticipants.size && !intersects(requestedParticipants, storedParticipants)) return false;
  }
  return true;
}

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
    this.stats = { stored: 0, hits: 0, misses: 0, pruned: 0, messageHits: 0, messageMisses: 0 };
  }

  /**
   * @param {object} raw     original Baileys message
   * @param {object} msg     normalised message (core/message.js)
   * @param {string} sessionJid
   */
  store(raw, msg, sessionJid) {
    if (!msg?.id || !raw?.key || msg.sensitive) return;

    // Keep the full protobuf only in memory: encrypted message edits require
    // messageContextInfo.messageSecret, but it is never written to SQLite.
    this.#rememberRaw(msg.id, raw);

    // AI context is a separate, explicit transcript store: it keeps both sides
    // of a conversation, while the forensic cache below remains inbound-only.
    const transcript = String(msg.text || '').trim();
    if (transcript && !msg.isGroup) {
      this.db.prepare(
        `INSERT INTO conversation_cache(id, session_jid, chat_jid, sender_jid, from_me, text, ts)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET text = excluded.text, from_me = excluded.from_me`
      ).run(
        msg.id,
        normalizeJid(sessionJid),
        normalizeJid(msg.jid),
        normalizeJid(msg.sender),
        raw.key.fromMe || msg.isBot ? 1 : 0,
        transcript,
        msg.timestamp * 1000
      );
    }

    if (msg.isBot) return; // own messages stay out of the forensic search cache

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
        sqliteInteger(msg.media?.payload?.fileLength),
        msg.media ? 1 : 0,
        msg.viewOnce ? 1 : 0,
        msg.timestamp * 1000
      );

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
   * Baileys callback for message-secret lookups (encrypted edit decryption and
   * resend). Return content only when id, direction and chat identity match.
   */
  getMessage(key) {
    const raw = this.getRaw(key?.id);
    if (!matchesMessageKey(raw, key) || !raw?.message) {
      this.stats.messageMisses++;
      return undefined;
    }
    this.stats.messageHits++;
    return raw.message;
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
