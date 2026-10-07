/**
 * Nexus-WA — profile watch and block inference.
 *
 * Tracks when a contact's display name or profile picture changes, and raises
 * a *suspicion* when the combination of signals suggests you have been blocked.
 *
 * Being straight about the limits: WhatsApp never tells you that you are
 * blocked. There is no API for it. What follows is a heuristic built from
 * signals we genuinely receive —
 *   • the profile picture went from present to absent
 *   • presence has been 'unavailable' for a long time
 *   • their name reverted to a bare phone number
 * — and every result is labelled "suspected", never asserted. People also
 * delete their photos and turn off last-seen for entirely innocent reasons,
 * and a false "you're blocked" message is worse than no message at all.
 */

import { normalizeJid, jidToPhone } from './jid.js';
import { flag, setFlag } from '../database/index.js';

export class ProfileWatch {
  constructor({ db, logger, presenceLog = null, selfJid = null }) {
    this.db = db;
    this.logger = logger.child({ scope: 'profile-watch' });
    this.presenceLog = presenceLog;
    this.selfJid = selfJid;
    this.stats = { nameChanges: 0, photoChanges: 0, photoRemoved: 0, suspects: 0 };
  }

  enabled() {
    return flag(this.db, 'profilewatch.enabled', true);
  }
  setEnabled(on) {
    setFlag(this.db, 'profilewatch.enabled', on);
    return this.enabled();
  }

  /**
   * Record an observation. `photo` is the profile-picture id or URL; treat an
   * empty value as "no photo".
   * @returns {object[]} the changes detected (empty if nothing changed)
   */
  observe({ jid, name = null, photo = null, status = null }) {
    const j = normalizeJid(jid);
    if (!j) return [];
    const now = Date.now();
    const prev = this.db
      .prepare('SELECT * FROM profiles WHERE jid = ?')
      .get(j);

    if (!prev) {
      this.db
        .prepare(
          `INSERT INTO profiles(jid, name, status, photo_id, first_seen, last_change)
           VALUES (?,?,?,?,?,?)`
        )
        .run(j, name, status, photo ? String(photo) : null, now, now);
      return [];
    }

    const changes = [];
    const record = (field, oldValue, newValue) => {
      changes.push({ jid: j, field, oldValue, newValue, ts: now });
      this.db
        .prepare('INSERT INTO profile_events(jid, field, old_value, new_value, ts) VALUES (?,?,?,?,?)')
        .run(j, field, oldValue === null ? '' : String(oldValue), newValue === null ? '' : String(newValue), now);
    };

    if (name !== null && prev.name !== null && name !== prev.name) {
      record('name', prev.name, name);
      this.stats.nameChanges++;
    }
    if (photo !== null) {
      const p = String(photo);
      if (prev.photo_id && p !== prev.photo_id) {
        record('photo', prev.photo_id, p);
        this.stats.photoChanges++;
      }
    }
    if (photo === '' && prev.photo_id) {
      record('photo', prev.photo_id, '');
      this.stats.photoRemoved++;
    }
    if (status !== null && prev.status !== null && status !== prev.status) {
      record('status', prev.status, status);
    }

    if (changes.length) {
      this.db
        .prepare(
          `UPDATE profiles
              SET name        = COALESCE(?, name),
                  status      = COALESCE(?, status),
                  photo_id    = CASE WHEN ? IS NULL THEN photo_id ELSE ? END,
                  last_change = ?
            WHERE jid = ?`
        )
        .run(name, status, photo === null ? null : 1, photo === null ? null : String(photo), now, j);
    }

    return changes;
  }

  /**
   * Block suspicion. Requires at least TWO independent signals so a single
   * deleted photo does not raise an alarm.
   * @returns {{suspected:boolean, score:number, signals:string[]}}
   */
  suspectBlocked(jid) {
    const j = normalizeJid(jid);
    const p = this.db.prepare('SELECT * FROM profiles WHERE jid = ?').get(j);
    const signals = [];

    if (p) {
      const removedPhoto = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM profile_events
            WHERE jid = ? AND field = 'photo' AND new_value = '' AND old_value <> ''`
        )
        .get(j).n;
      if (removedPhoto > 0) signals.push('profile photo removed');
      if (p.status === '') signals.push('status/about cleared');
    }

    const presence = this.presenceLog?.get(j);
    if (presence?.state === 'unavailable') {
      const ageH = (Date.now() - (presence.last_seen || 0)) / 3600000;
      if (ageH > 72) signals.push(`no presence for ${Math.round(ageH)}h`);
    }

    // A contact whose only label is a bare number suggests the entry is gone.
    const contact = this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(j);
    if (contact && !contact.local_name && jidToPhone(j)) {
      signals.push('no saved name in your address book');
    }

    const score = signals.length;
    const suspected = score >= 2;
    if (suspected) {
      this.db.prepare('UPDATE profiles SET blocked_suspect = 1 WHERE jid = ?').run(j);
      this.stats.suspects++;
    }
    return { suspected, score, signals };
  }

  changes(limit = 30) {
    return this.db
      .prepare('SELECT * FROM profile_events ORDER BY ts DESC LIMIT ?')
      .all(limit);
  }

  tracked() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
  }

  suspects() {
    return this.db
      .prepare('SELECT jid FROM profiles WHERE blocked_suspect = 1 ORDER BY last_change DESC LIMIT 100')
      .all()
      .map((r) => r.jid);
  }
}

/** Render a change list for a notification. */
export function formatProfileChanges(changes, nameOf = (jid) => jid) {
  if (!changes?.length) return null;
  const byContact = new Map();
  for (const c of changes) {
    if (!byContact.has(c.jid)) byContact.set(c.jid, []);
    byContact.get(c.jid).push(c);
  }
  const lines = ['👤 *Profile changes*', ''];
  for (const [jid, list] of byContact) {
    lines.push(`*${nameOf(jid)}*`);
    for (const c of list) {
      const label = { name: 'name', photo: 'profile photo', status: 'about' }[c.field] || c.field;
      if (c.field === 'photo') {
        lines.push(`  • ${c.newValue ? 'changed their photo' : 'removed their photo'}`);
      } else {
        lines.push(`  • ${label}: "${c.oldValue || '(empty)'}" → "${c.newValue || '(empty)'}"`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export default ProfileWatch;
