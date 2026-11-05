/**
 * Short text transcript of every chat, both sides, groups included. Backs
 * `.ai <n> <question>`, which needs the last n messages of the chat it was
 * asked in. Kept separate from conversation_cache, which is one-to-one only.
 *
 * Text only, capped per chat, no media. Status broadcasts and messages marked
 * sensitive are never stored.
 */
import { normalizeJid } from './jid.js';

const PER_CHAT_CAP = 300;
const MAX_TEXT = 1_000;

export class ChatContext {
  constructor({ db, now = () => Date.now() }) {
    this.db = db;
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_text (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        sender_jid TEXT,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_text_chat ON chat_text(chat_jid, ts DESC);
    `);
  }

  /** @param {object} msg normalised message from core/message.js */
  record(msg) {
    if (!msg?.id || !msg.jid || msg.sensitive) return false;
    const chat = normalizeJid(msg.jid);
    if (!chat || chat === 'status@broadcast') return false;

    const text = String(msg.text || '').trim();
    // Our own AI answers carry the "AI's Answer" label near the start.
    if (!text || text.slice(0, 40).includes("AI's Answer")) return false;

    const ts = Math.round(Number(msg.timestamp) * 1_000) || this.now();
    this.db.prepare(
      `INSERT INTO chat_text (id, chat_jid, from_me, sender_jid, text, ts)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text`
    ).run(
      String(msg.id),
      chat,
      msg.isBot ? 1 : 0,
      msg.sender ? normalizeJid(msg.sender) : null,
      text.slice(0, MAX_TEXT),
      ts
    );

    this.db.prepare(
      `DELETE FROM chat_text
        WHERE chat_jid = ?
          AND id NOT IN (
            SELECT id FROM chat_text WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?
          )`
    ).run(chat, chat, PER_CHAT_CAP);
    return true;
  }

  /** Last `limit` messages of a chat, oldest first. */
  recent(chatJid, limit = 5) {
    const rows = this.db.prepare(
      `SELECT from_me, sender_jid, text, ts FROM chat_text
        WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?`
    ).all(normalizeJid(chatJid), Math.max(1, Math.min(limit, PER_CHAT_CAP)));
    return rows.reverse();
  }
}

export default ChatContext;
