/**
 * Questions the bot is waiting on for the owner: a missing command argument,
 * or a status number to pick. One pending question per chat. Each entry carries
 * its own onReply handler and expires after a while, so a stale question never
 * swallows an unrelated message.
 */
export class PendingPrompts {
  constructor({ ttlMs = 5 * 60_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, {onReply: Function, expires: number}>} */
    this.entries = new Map();
  }

  set(chatJid, entry, { ttlMs = this.ttlMs } = {}) {
    this.entries.set(String(chatJid), { ...entry, expires: this.now() + ttlMs });
  }

  has(chatJid) {
    const key = String(chatJid);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** The live entry for a chat without consuming it, or null. */
  peek(chatJid) {
    return this.has(chatJid) ? this.entries.get(String(chatJid)) : null;
  }

  /** Remove and return the pending entry for a chat, or null. */
  take(chatJid) {
    if (!this.has(chatJid)) return null;
    const key = String(chatJid);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry;
  }

  clear(chatJid) {
    return this.entries.delete(String(chatJid));
  }
}

export default PendingPrompts;
