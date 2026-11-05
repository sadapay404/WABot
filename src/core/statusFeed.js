/**
 * Statuses (stories) the bot saw while online. WhatsApp only delivers statuses
 * live, so this is strictly "received while the bot was running".
 *
 * Statuses are stored, never viewed or marked read: the bot does not call
 * readMessages on status@broadcast. Raw payloads are kept so a chosen status
 * can be re-downloaded and re-sent. Entries older than KEEP_MS are pruned.
 */
import { normalizeJid, jidToPhone } from './jid.js';

const STATUS_JID = 'status@broadcast';
const KEEP_MS = 48 * 60 * 60 * 1_000;
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'sticker', 'document']);

/** JSON that survives Buffers and Uint8Arrays (Baileys media keys are bytes). */
function replacer(_key, value) {
  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return { __bytes: Buffer.from(value.data).toString('base64') };
  }
  if (value instanceof Uint8Array) return { __bytes: Buffer.from(value).toString('base64') };
  return value;
}

function reviver(_key, value) {
  if (value && typeof value === 'object' && typeof value.__bytes === 'string') {
    return Buffer.from(value.__bytes, 'base64');
  }
  return value;
}

export class StatusFeed {
  constructor({ db, now = () => Date.now() }) {
    this.db = db;
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS status_feed (
        id TEXT PRIMARY KEY,
        poster_jid TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT,
        text TEXT,
        has_media INTEGER NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_status_feed_ts ON status_feed(ts DESC);
    `);
  }

  /**
   * @param {object} raw  Baileys message as received
   * @param {object} msg  normalised message (core/message.js)
   * @returns {boolean} true if stored
   */
  record(raw, msg) {
    if (normalizeJid(raw?.key?.remoteJid) !== STATUS_JID) return false;
    const id = raw?.key?.id;
    const poster = normalizeJid(raw?.key?.participant || raw?.participant || '');
    if (!id || !poster) return false;

    let json;
    try {
      json = JSON.stringify(raw, replacer);
    } catch {
      return false;
    }

    const kind = msg?.media?.kind || msg?.media?.type || null;
    const ts = Math.round(Number(msg?.timestamp) * 1_000) || this.now();
    this.db.prepare(
      `INSERT OR REPLACE INTO status_feed
         (id, poster_jid, from_me, ts, kind, text, has_media, raw_json)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      String(id),
      poster,
      raw.key.fromMe ? 1 : 0,
      ts,
      kind,
      String(msg?.text || '').slice(0, 500) || null,
      MEDIA_KINDS.has(kind) ? 1 : 0,
      json
    );

    this.db.prepare('DELETE FROM status_feed WHERE ts < ?').run(this.now() - KEEP_MS);
    return true;
  }

  /** Newest first. */
  list(limit = 20) {
    return this.db.prepare(
      `SELECT id, poster_jid, from_me, ts, kind, text, has_media
         FROM status_feed ORDER BY ts DESC LIMIT ?`
    ).all(Math.max(1, Math.min(limit, 100)));
  }

  /** Full row including the revived raw Baileys message, or null. */
  get(id) {
    const row = this.db.prepare('SELECT * FROM status_feed WHERE id = ?').get(String(id));
    if (!row) return null;
    let raw = null;
    try {
      raw = JSON.parse(row.raw_json, reviver);
    } catch {
      raw = null;
    }
    return { ...row, raw, phone: jidToPhone(row.poster_jid) };
  }
}

export default StatusFeed;
