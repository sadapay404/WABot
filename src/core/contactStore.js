/**
 * Nexus-WA — contact store.
 *
 * Baileys v7 removed `makeInMemoryStore`, so contacts have to be captured
 * ourselves. WhatsApp pushes them two ways:
 *
 *   • `contacts.update`       — { id, name, notify, verifiedName }
 *       `name`   = the name saved in YOUR address book  ← what you asked for
 *       `notify` = the push name they chose for themselves
 *   • `messaging-history.set` — bulk history sync on first link
 *
 * We persist both, because the distinction matters: "Mom" is yours, "Sarah 🌸"
 * is theirs, and when someone deletes a message you want to know which is which.
 */

import { normalizeJid, jidToPhone, resolvePhone } from './jid.js';

export class ContactStore {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger.child({ scope: 'contacts' });
    /** in-memory read-through cache so hot paths never hit SQLite */
    this.mem = new Map();
    this.stats = { updates: 0 };
  }

  /**
   * @param {object} c  { id, name, notify, verifiedName }
   */
  upsert(c) {
    const jid = normalizeJid(c.id);
    if (!jid) return;
    this.stats.updates++;

    const existing = this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid) || {};
    const localName = c.name ?? existing.local_name ?? null;
    const notifyName = c.notify ?? existing.notify_name ?? null;
    const verifiedName = c.verifiedName ?? existing.verified_name ?? null;
    const phone = jidToPhone(jid);
    const info = phone ? resolvePhone(phone) : null;

    this.db
      .prepare(
        `INSERT INTO contacts(jid, local_name, notify_name, verified_name,
                              phone_e164, country_iso, country_name, last_seen)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(jid) DO UPDATE SET
           local_name    = excluded.local_name,
           notify_name   = excluded.notify_name,
           verified_name = excluded.verified_name,
           phone_e164    = COALESCE(excluded.phone_e164, phone_e164),
           country_iso   = COALESCE(excluded.country_iso, country_iso),
           country_name  = COALESCE(excluded.country_name, country_name),
           last_seen     = excluded.last_seen`
      )
      .run(
        jid,
        localName,
        notifyName,
        verifiedName,
        info?.e164 || null,
        info?.countryIso || null,
        info?.countryName || null,
        Date.now()
      );

    this.mem.set(jid, this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid));
  }

  /** Bulk-load from a history sync payload. */
  upsertMany(list = []) {
    for (const c of list) this.upsert(c);
    return list.length;
  }

  get(jid) {
    const j = normalizeJid(jid);
    if (this.mem.has(j)) return this.mem.get(j);
    const row = this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(j) || null;
    if (row) this.mem.set(j, row);
    return row;
  }

  /**
   * Best human label for a JID, most personal first.
   * @returns {{name:string, source:'local'|'notify'|'verified'|'phone'|'jid'}}
   */
  displayName(jid, fallback = null) {
    const c = this.get(jid);
    if (c?.local_name) return { name: c.local_name, source: 'local' };
    if (c?.verified_name) return { name: c.verified_name, source: 'verified' };
    if (c?.notify_name) return { name: c.notify_name, source: 'notify' };
    const phone = jidToPhone(jid);
    if (phone) return { name: `+${phone}`, source: 'phone' };
    return { name: fallback || normalizeJid(jid), source: 'jid' };
  }

  /** Full profile used by the anti-delete notifier and the dashboard. */
  profile(jid) {
    const c = this.get(jid) || {};
    const phone = jidToPhone(jid);
    const info = phone ? resolvePhone(phone) : null;
    const { name, source } = this.displayName(jid);
    return {
      jid: normalizeJid(jid),
      name,
      nameSource: source,
      localName: c.local_name || null,
      notifyName: c.notify_name || null,
      phoneE164: info?.e164 || c.phone_e164 || null,
      phoneNational: info?.national || null,
      countryIso: info?.countryIso || c.country_iso || null,
      countryName: info?.countryName || c.country_name || null,
      numberValid: info?.valid ?? false,
      numberType: info?.type || null,
    };
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  }

  /** Contacts that have a name saved in YOUR address book. */
  named() {
    return this.db
      .prepare(
        `SELECT jid, local_name, notify_name, country_name
           FROM contacts
          WHERE local_name IS NOT NULL AND local_name <> ''
          ORDER BY local_name
          LIMIT 500`
      )
      .all();
  }
}

export default ContactStore;
