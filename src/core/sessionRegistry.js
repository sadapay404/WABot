/**
 * Nexus-WA — session registry.
 *
 * The single record of every WhatsApp number this install has ever been linked
 * to, plus how each one behaved. This is what powers the dashboard and what
 * makes the burner → primary migration auditable: you can see exactly which
 * number was connected when, for how long, and how much traffic it pushed.
 */

import { normalizeJid, jidToPhone, resolvePhone } from './jid.js';

export class SessionRegistry {
  /**
   * @param {object} db driver-agnostic handle from database/index.js
   * @param {object} logger
   */
  constructor(db, logger) {
    this.db = db;
    this.logger = logger.child({ scope: 'sessions' });
  }

  /**
   * Register (or refresh) a connected number.
   * @returns {object} the session row
   */
  upsert({ jid, pushName = null, role = 'burner', notes = null }) {
    const j = normalizeJid(jid);
    if (!j) throw new Error('upsert() needs a JID');

    const phone = resolvePhone(j);
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM sessions WHERE jid = ?').get(j);

    if (existing) {
      this.db
        .prepare(
          `UPDATE sessions
              SET last_seen     = ?,
                  connect_count = connect_count + 1,
                  push_name     = COALESCE(?, push_name),
                  role          = COALESCE(?, role),
                  notes         = COALESCE(?, notes),
                  status        = CASE WHEN status IN ('retired','logged_out') THEN 'active' ELSE status END,
                  phone_e164    = COALESCE(?, phone_e164),
                  country_iso   = COALESCE(?, country_iso),
                  country_name  = COALESCE(?, country_name),
                  phone_national= COALESCE(?, phone_national)
            WHERE jid = ?`
        )
        .run(
          now,
          pushName,
          role,
          notes,
          phone.e164 || null,
          phone.countryIso,
          phone.countryName,
          phone.national || null,
          j
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO sessions
             (jid, phone_e164, phone_national, country_iso, country_name, push_name,
              role, status, first_seen, last_seen, connect_count)
           VALUES (?,?,?,?,?,?,?,?,?,?,1)`
        )
        .run(
          j,
          phone.e164 || null,
          phone.national || null,
          phone.countryIso,
          phone.countryName,
          pushName,
          role,
          'active',
          now,
          now
        );
    }

    this.event(j, 'connect');
    const row = this.get(j);
    this.logger.info(
      `session ${phone.e164 || j} (${phone.countryName || 'unknown country'}) ` +
        `connect #${row.connect_count}`
    );
    return row;
  }

  get(jid) {
    return this.db.prepare('SELECT * FROM sessions WHERE jid = ?').get(normalizeJid(jid)) || null;
  }

  list() {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY last_seen DESC, first_seen DESC')
      .all();
  }

  setStatus(jid, status, detail = null) {
    const j = normalizeJid(jid);
    this.db
      .prepare('UPDATE sessions SET status = ?, last_seen = ? WHERE jid = ?')
      .run(status, Date.now(), j);
    this.event(j, `status:${status}`, detail);
    this.logger.warn(`session ${j} → ${status}${detail ? ` (${detail})` : ''}`);
  }

  event(jid, kind, detail = null) {
    const s = this.get(jid);
    if (!s) return;
    this.db
      .prepare(
        'INSERT INTO connection_events(session_id, ts, kind, detail) VALUES(?,?,?,?)'
      )
      .run(s.id, Date.now(), kind, detail ? String(detail).slice(0, 500) : null);
  }

  events(jid, limit = 50) {
    const s = this.get(jid);
    if (!s) return [];
    return this.db
      .prepare(
        'SELECT ts, kind, detail FROM connection_events WHERE session_id = ? ORDER BY ts DESC LIMIT ?'
      )
      .all(s.id, limit);
  }

  countIn(jid, n = 1) {
    this.db
      .prepare('UPDATE sessions SET messages_in = messages_in + ? WHERE jid = ?')
      .run(n, normalizeJid(jid));
  }
  countOut(jid, n = 1) {
    this.db
      .prepare('UPDATE sessions SET messages_out = messages_out + ? WHERE jid = ?')
      .run(n, normalizeJid(jid));
  }
  countDeletion(jid, n = 1) {
    this.db
      .prepare('UPDATE sessions SET deletions_seen = deletions_seen + ? WHERE jid = ?')
      .run(n, normalizeJid(jid));
  }

  /** Aggregate numbers for the dashboard header. */
  summary() {
    const rows = this.list();
    const now = Date.now();
    return {
      total: rows.length,
      active: rows.filter((r) => r.status === 'active').length,
      retired: rows.filter((r) => r.status === 'retired').length,
      loggedOut: rows.filter((r) => r.status === 'logged_out').length,
      banned: rows.filter((r) => r.status === 'banned').length,
      burners: rows.filter((r) => r.role === 'burner').length,
      primaries: rows.filter((r) => r.role === 'primary').length,
      countries: [...new Set(rows.map((r) => r.country_name).filter(Boolean))],
      messagesIn: rows.reduce((a, r) => a + r.messages_in, 0),
      messagesOut: rows.reduce((a, r) => a + r.messages_out, 0),
      deletionsSeen: rows.reduce((a, r) => a + r.deletions_seen, 0),
      events: this.db.prepare('SELECT COUNT(*) AS n FROM connection_events').get().n,
      oldest: rows.length ? Math.min(...rows.map((r) => r.first_seen)) : null,
      newest: rows.length ? Math.max(...rows.map((r) => r.last_seen || 0)) : null,
      uptimeWindowMs: rows.length ? now - Math.min(...rows.map((r) => r.first_seen)) : 0,
    };
  }
}

export default SessionRegistry;
export { jidToPhone };
