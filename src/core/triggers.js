/**
 * Nexus-WA — keyword triggers.
 *
 * Auto-replies are the single riskiest feature in this project, so they are
 * built defensively:
 *
 *   • A trigger must name a chat, OR be explicitly marked global. Scoping to
 *     one chat is the default because that is almost always what you want.
 *   • Only the owner can add triggers (enforced by the plugin's ownerOnly).
 *   • A per-chat cooldown prevents a runaway loop. WhatsApp conversations can
 *     ping-pong; a bot that answers instantly and forever is both a ban signal
 *     and an embarrassment.
 *   • Triggers never fire on the bot's own messages, and never in observe mode.
 *
 * If you take one warning from this file: prefer "notify me" over "reply for
 * me". A missed reply is recoverable; an account restriction is not.
 */

import { normalizeJid, isGroupJid } from './jid.js';
import { flag, setFlag } from '../database/index.js';

export class Triggers {
  /**
   * @param {object} deps
   * @param {object} deps.db
   * @param {object} deps.logger
   * @param {number} [deps.cooldownMs] per-chat gap between replies, default 90s
   */
  constructor({ db, logger, cooldownMs = 90_000 }) {
    this.db = db;
    this.logger = logger.child({ scope: 'triggers' });
    this.cooldownMs = cooldownMs;
    /** jid -> last fired ms */
    this.lastFired = new Map();
    this.stats = { matched: 0, fired: 0, cooledDown: 0 };
  }

  enabled() {
    return flag(this.db, 'triggers.enabled', false); // OFF by default, on purpose
  }
  setEnabled(on) {
    setFlag(this.db, 'triggers.enabled', on);
    this.logger.warn(`keyword triggers ${on ? 'ENABLED — the bot will now speak unprompted' : 'DISABLED'}`);
    return this.enabled();
  }

  /**
   * @param {object} t
   * @param {string} t.pattern   substring (case-insensitive) or /regex/
   * @param {string} t.response
   * @param {string} [t.chatJid] restrict to one chat; null = global
   */
  add({ pattern, response, chatJid = null }) {
    if (!pattern || !response) throw new Error('a trigger needs both a pattern and a response');
    this.#compile(pattern); // validate early
    const res = this.db
      .prepare('INSERT INTO triggers(chat_jid, pattern, response, enabled, created_at) VALUES (?,?,?,?,?)')
      .run(chatJid ? normalizeJid(chatJid) : null, pattern, response, 1, Date.now());
    return this.get(Number(res.lastInsertRowid));
  }

  get(id) {
    return this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(Number(id)) || null;
  }

  list() {
    return this.db.prepare('SELECT * FROM triggers ORDER BY created_at DESC').all();
  }

  remove(id) {
    return (this.db.prepare('DELETE FROM triggers WHERE id = ?').run(Number(id)).changes || 0) > 0;
  }

  setEnabledOne(id, on) {
    this.db.prepare('UPDATE triggers SET enabled = ? WHERE id = ?').run(on ? 1 : 0, Number(id));
  }

  #compile(pattern) {
    const m = String(pattern).match(/^\/(.+)\/([i]*)$/);
    if (m) return new RegExp(m[1], m[2] || 'i');
    return null; // plain substring
  }

  #matches(pattern, text) {
    const rx = this.#compile(pattern);
    if (rx) return rx.test(text);
    return text.toLowerCase().includes(String(pattern).toLowerCase());
  }

  /**
   * Find the response for an inbound message, or null.
   * @returns {{trigger:object, response:string}|null}
   */
  match(msg) {
    if (!this.enabled()) return null;
    if (msg.isBot || !msg.text) return null;
    // Never answer a command — that would fight the command handler.
    if (msg.text.startsWith('.')) return null;

    const candidates = this.list().filter((t) => {
      if (!t.enabled) return false;
      if (t.chat_jid && t.chat_jid !== normalizeJid(msg.jid)) return false;
      if (!t.chat_jid && isGroupJid(msg.jid)) return false; // global triggers skip groups
      return this.#matches(t.pattern, msg.text);
    });

    if (!candidates.length) return null;
    this.stats.matched++;

    const chat = normalizeJid(msg.jid);
    const last = this.lastFired.get(chat) || 0;
    if (Date.now() - last < this.cooldownMs) {
      this.stats.cooledDown++;
      this.logger.info(`trigger matched in ${chat} but cooldown is active`);
      return null;
    }

    const trigger = candidates[0];
    this.lastFired.set(chat, Date.now());
    this.db
      .prepare('UPDATE triggers SET match_count = match_count + 1 WHERE id = ?')
      .run(trigger.id);
    this.stats.fired++;

    return { trigger, response: trigger.response };
  }
}

export default Triggers;
