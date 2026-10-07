/**
 * Nexus-WA — audit log.
 *
 * Every action the bot takes on your behalf, with who caused it. When a bot is
 * attached to your personal number, "what did it send, and why?" has to be
 * answerable after the fact. This is that record.
 *
 * It is a plain append-only table — no rotation, no cleverness. Storage is
 * trivial (a few hundred bytes per event) and the value when something goes
 * wrong is out of proportion to the cost.
 */

import { normalizeJid } from './jid.js';

export class AuditLog {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger.child({ scope: 'audit' });
  }

  /**
   * @param {object} e
   * @param {string} e.action      verb, e.g. 'send', 'delete', 'mode-change'
   * @param {string} [e.actorJid]  who triggered it
   * @param {string} [e.plugin]    which plugin or service
   * @param {string} [e.targetJid] who/where it affected
   * @param {string} [e.detail]
   */
  record({ action, actorJid = null, plugin = null, targetJid = null, detail = null }) {
    try {
      this.db
        .prepare(
          `INSERT INTO audit(ts, actor_jid, plugin, action, target_jid, detail)
           VALUES (?,?,?,?,?,?)`
        )
        .run(
          Date.now(),
          actorJid ? normalizeJid(actorJid) : null,
          plugin,
          String(action),
          targetJid ? normalizeJid(targetJid) : null,
          detail ? String(detail).slice(0, 1000) : null
        );
    } catch (err) {
      // Auditing must never break the action being audited.
      this.logger.error(`audit write failed: ${err.message}`);
    }
  }

  recent(limit = 50, { plugin = null } = {}) {
    return plugin
      ? this.db.prepare('SELECT * FROM audit WHERE plugin = ? ORDER BY ts DESC, id DESC LIMIT ?').all(plugin, limit)
      : this.db.prepare('SELECT * FROM audit ORDER BY ts DESC, id DESC LIMIT ?').all(limit);
  }

  /** Renders as plain text for Telegram / WhatsApp. */
  text(limit = 25) {
    const rows = this.recent(limit);
    if (!rows.length) return 'No audited actions yet.';
    return rows
      .map((r) => {
        const when = new Date(r.ts).toISOString().slice(5, 16).replace('T', ' ');
        const who = r.actor_jid ? r.actor_jid.split('@')[0] : 'system';
        return `${when} ${who} → ${r.action}${r.plugin ? ` [${r.plugin}]` : ''}${
          r.detail ? ` — ${String(r.detail).slice(0, 80)}` : ''
        }`;
      })
      .join('\n');
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
  }

  prune(olderThanMs = 90 * 86_400_000) {
    return this.db.prepare('DELETE FROM audit WHERE ts < ?').run(Date.now() - olderThanMs).changes || 0;
  }
}

export default AuditLog;
