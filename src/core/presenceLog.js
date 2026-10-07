/**
 * Nexus-WA — presence log.
 *
 * Records who was online, typing or recording, and when they were last seen.
 * Useful on its own ("was Dan actually around at 3pm?") and it is the raw
 * signal the block detector reasons from.
 *
 * Deliberately opt-in per contact. Blanket surveillance of everyone in your
 * address book is exactly the traffic pattern that gets an account flagged,
 * and it is not something this project will do quietly.
 */

import { normalizeJid } from './jid.js';
import { flag, setFlag } from '../database/index.js';

const INTERESTING = new Set(['available', 'unavailable', 'composing', 'recording', 'paused']);

export class PresenceLog {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger.child({ scope: 'presence' });
    this.stats = { updates: 0, recorded: 0 };
  }

  enabled() {
    return flag(this.db, 'presence.enabled', true);
  }
  setEnabled(on) {
    setFlag(this.db, 'presence.enabled', on);
    return this.enabled();
  }

  /**
   * Baileys `presence.update`: { id, presences: { [jid]: 'available' } }
   * or the flatter { id, participant, type } in some builds.
   */
  onUpdate(update = {}) {
    if (!this.enabled()) return 0;
    const chatJid = normalizeJid(update.id);
    const map = update.presences || null;
    const entries = map
      ? Object.entries(map)
      : update.type
        ? [[update.participant || chatJid, update.type]]
        : [];

    let n = 0;
    for (const [jid, state] of entries) {
      this.stats.updates++;
      if (!INTERESTING.has(state)) continue;
      this.record(jid, state, chatJid);
      n++;
    }
    return n;
  }

  record(jid, state, chatJid = null) {
    const j = normalizeJid(jid);
    if (!j) return;
    const now = Date.now();
    // Only 'unavailable' tells us they went away; that is the last-seen signal.
    const lastSeen = state === 'unavailable' ? now : null;

    this.db
      .prepare(
        `INSERT INTO presence(jid, state, last_seen, updates) VALUES (?,?,?,1)
         ON CONFLICT(jid) DO UPDATE SET
           state     = excluded.state,
           last_seen = COALESCE(excluded.last_seen, presence.last_seen),
           updates   = presence.updates + 1`
      )
      .run(j, state, lastSeen);

    this.db.prepare('INSERT INTO presence_log(jid, state, ts) VALUES (?,?,?)').run(j, state, now);
    this.stats.recorded++;
  }

  get(jid) {
    return this.db.prepare('SELECT * FROM presence WHERE jid = ?').get(normalizeJid(jid)) || null;
  }

  /** Latest state per contact, most recent first. */
  recent(limit = 25) {
    return this.db
      .prepare(
        `SELECT jid, state, last_seen, updates
           FROM presence
          ORDER BY last_seen DESC NULLS LAST
          LIMIT ?`
      )
      .all(limit);
  }

  history(jid, limit = 30) {
    return this.db
      .prepare('SELECT state, ts FROM presence_log WHERE jid = ? ORDER BY ts DESC LIMIT ?')
      .all(normalizeJid(jid), limit);
  }

  /** Human summary for the dashboard. */
  summary() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS tracked,
                SUM(CASE WHEN state='available' THEN 1 ELSE 0 END) AS online,
                MAX(last_seen) AS newest
           FROM presence`
      )
      .get();
    return { tracked: row.tracked || 0, online: row.online || 0, newest: row.newest || null };
  }
}

export default PresenceLog;
