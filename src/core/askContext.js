import { normalizeJid } from './jid.js';

const MENU_TTL_MS = 30 * 60 * 1_000;
const MENU_LIMIT = 30;
const MAX_FETCH = 5_000;

function menuKey(ownerJid, controlChat) {
  return `${normalizeJid(ownerJid)}\u0000${normalizeJid(controlChat)}`;
}

/** Owner-scoped snapshots and transcript reads for `.ask`. */
export class AskContext {
  constructor({ db, now = () => Date.now() }) {
    this.db = db;
    this.now = now;
    this.menus = new Map();
  }

  listChats({ ownerJid, controlChat, selfJid, ownerJids = [] }) {
    const excluded = new Set(
      [selfJid, ...ownerJids].map(normalizeJid).filter(Boolean)
    );
    const rows = this.db.prepare(
      `SELECT chat_jid, MAX(chat_jid_alt) AS chat_jid_alt,
              COUNT(*) AS message_count, MAX(ts) AS last_at
         FROM conversation_cache
        WHERE (chat_jid LIKE '%@s.whatsapp.net' OR chat_jid LIKE '%@lid')
        GROUP BY chat_jid
        ORDER BY last_at DESC
        LIMIT ?`
    ).all(MENU_LIMIT + excluded.size + 1)
      .filter((row) => !excluded.has(normalizeJid(row.chat_jid)) &&
        !(row.chat_jid_alt && excluded.has(normalizeJid(row.chat_jid_alt))))
      .slice(0, MENU_LIMIT);

    const key = menuKey(ownerJid, controlChat);
    this.menus.set(key, { rows, expiresAt: this.now() + MENU_TTL_MS });
    this.#pruneMenus();
    return rows;
  }

  resolve(ownerJid, controlChat, indexes) {
    const key = menuKey(ownerJid, controlChat);
    const snapshot = this.menus.get(key);
    if (!snapshot || snapshot.expiresAt <= this.now()) {
      this.menus.delete(key);
      return null;
    }
    const rows = [];
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 1 || index > snapshot.rows.length) return null;
      const row = snapshot.rows[index - 1];
      if (!rows.some((item) => normalizeJid(item.chat_jid) === normalizeJid(row.chat_jid))) rows.push(row);
    }
    return rows;
  }

  /** Resolve only the explicitly supplied direct JID/phone aliases. */
  resolveDirect(jids, { selfJid, ownerJids = [] } = {}) {
    const excluded = new Set([selfJid, ...ownerJids].map(normalizeJid).filter(Boolean));
    const selected = [];
    for (const value of jids || []) {
      const jid = normalizeJid(value);
      if (!jid || excluded.has(jid)) return null;
      const matches = this.db.prepare(
        `SELECT chat_jid, MAX(chat_jid_alt) AS chat_jid_alt
           FROM conversation_cache
          WHERE chat_jid = ? OR chat_jid_alt = ?
          GROUP BY chat_jid
          ORDER BY MAX(ts) DESC
          LIMIT 2`
      ).all(jid, jid);
      if (!matches.length) return null;
      const match = matches[0];
      if (excluded.has(normalizeJid(match.chat_jid)) ||
          (match.chat_jid_alt && excluded.has(normalizeJid(match.chat_jid_alt)))) return null;
      if (!selected.some((item) => normalizeJid(item.chat_jid) === normalizeJid(match.chat_jid))) {
        selected.push(match);
      }
    }
    return selected.length ? selected : null;
  }

  messages(chatJid, { altJid = null, limit = 200, all = false, startTs = null, endTs = null } = {}) {
    const jid = normalizeJid(chatJid);
    const alt = altJid ? normalizeJid(altJid) : null;
    const safeLimit = all ? MAX_FETCH : Math.max(1, Math.min(Number(limit) || 1, MAX_FETCH));
    const conditions = ['(chat_jid = ? OR (? IS NOT NULL AND chat_jid_alt = ?))', "text <> ''"];
    const params = [jid, alt, alt];
    if (Number.isFinite(startTs)) {
      conditions.push('ts >= ?');
      params.push(startTs);
    }
    if (Number.isFinite(endTs)) {
      conditions.push('ts < ?');
      params.push(endTs);
    }
    const where = conditions.join(' AND ');
    const total = all
      ? this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_cache WHERE ${where}`).get(...params).n
      : null;
    const rows = this.db.prepare(
      `SELECT id, chat_jid, sender_jid, from_me, text, ts
         FROM conversation_cache
        WHERE ${where}
        ORDER BY ts DESC
        LIMIT ?`
    ).all(...params, safeLimit).reverse();
    return { rows, omitted: total === null ? 0 : Math.max(0, total - rows.length) };
  }

  #pruneMenus() {
    const now = this.now();
    for (const [key, item] of this.menus) {
      if (item.expiresAt <= now) this.menus.delete(key);
    }
    while (this.menus.size > 500) this.menus.delete(this.menus.keys().next().value);
  }
}

export default AskContext;
