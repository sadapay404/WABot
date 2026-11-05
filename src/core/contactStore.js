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

import { normalizeJid, isLidJid, isUserJid, jidToPhone, resolvePhone } from './jid.js';

function uniqueJids(values = []) {
  return [...new Set(values.map(normalizeJid).filter(Boolean))];
}

function contactName(row) {
  return row?.manual_name || row?.local_name || null;
}

export class ContactStore {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger.child({ scope: 'contacts' });
    /** in-memory read-through cache so hot paths never hit SQLite */
    this.mem = new Map();
    this.stats = { updates: 0, aliasesRejected: 0, aliasesRepaired: 0 };
    // Older builds accepted any pair of JIDs as an alias. Repair that legacy
    // state before a profile is ever rendered, so one accidental mapping can
    // never make every contact inherit the owner's name and number.
    this.repairAliases();
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
    for (const c of list) {
      this.upsert(c);
      // Baileys revisions use different spellings for a companion phone/LID
      // association. Only save an alias that arrived in the contact payload.
      const alternatives = [
        c.idAlt, c.idPn, c.idPN, c.lid, c.phoneJid,
        // Current Baileys Contact fields used by history sync.
        c.phoneNumber, c.pnJid,
      ].filter(Boolean);
      if (alternatives.length) this.linkAliases(c.id, ...alternatives);
    }
    return list.length;
  }

  /**
   * Persist exactly one protocol-observed LID ↔ phone-number relationship.
   *
   * A remoteJidAlt is useful only when it is the corresponding other identity;
   * it is not a general contact relationship. Mapping group IDs, two phone
   * JIDs, or multiple LIDs to one PN is how an owner's label can leak into
   * unrelated contacts, so those shapes are deliberately rejected.
   */
  linkAliases(...values) {
    const ids = uniqueJids(values);
    const lids = ids.filter(isLidJid);
    const pns = ids.filter(isUserJid);
    const requested = ids[0] || '';
    if (ids.length !== 2 || lids.length !== 1 || pns.length !== 1) {
      if (ids.length > 1) this.stats.aliasesRejected++;
      return this.canonicalJid(requested);
    }

    const [lid] = lids;
    const [pn] = pns;
    const now = Date.now();
    const previous = this.db
      .prepare('SELECT alias_jid FROM contact_aliases WHERE canonical_jid = ?')
      .all(pn)
      .map((row) => normalizeJid(row.alias_jid))
      .filter(Boolean);

    // A WhatsApp user has one current LID. If a legitimate protocol update
    // rotates it, replace the prior mapping instead of accumulating a fan-out.
    for (const oldLid of previous) {
      if (oldLid !== lid) this.db.prepare('DELETE FROM contact_aliases WHERE alias_jid = ?').run(oldLid);
      this.mem.delete(oldLid);
    }

    this.db.prepare(
      `INSERT INTO contact_aliases(alias_jid, canonical_jid, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(alias_jid) DO UPDATE SET canonical_jid = excluded.canonical_jid, updated_at = excluded.updated_at`
    ).run(lid, pn, now);
    this.mem.delete(lid);
    this.mem.delete(pn);
    return pn;
  }

  /**
   * Drop legacy/unsafe mappings before they can affect a display name.
   * Returning an empty or unknown number is safer than confidently attaching
   * the linked owner's identity to an unrelated person.
   */
  repairAliases() {
    const rows = this.db.prepare('SELECT alias_jid, canonical_jid FROM contact_aliases').all();
    const remove = new Set();
    const byPhone = new Map();
    for (const row of rows) {
      const alias = normalizeJid(row.alias_jid);
      const canonical = normalizeJid(row.canonical_jid);
      if (!isLidJid(alias) || !isUserJid(canonical)) {
        remove.add(alias || row.alias_jid);
        continue;
      }
      const list = byPhone.get(canonical) || [];
      list.push(alias);
      byPhone.set(canonical, list);
    }
    // More than one LID for a phone is ambiguous rather than a safe alias.
    // Remove the entire cluster; a later explicit Baileys mapping re-adds only
    // the current one.
    for (const aliases of byPhone.values()) {
      if (aliases.length > 1) aliases.forEach((alias) => remove.add(alias));
    }
    for (const alias of remove) {
      this.db.prepare('DELETE FROM contact_aliases WHERE alias_jid = ?').run(alias);
      this.mem?.delete(alias);
    }
    if (remove.size) {
      this.stats.aliasesRepaired += remove.size;
      this.logger.warn(`discarded ${remove.size} unsafe contact identity mapping(s)`);
    }
    return remove.size;
  }

  /** The phone JID when a verified protocol alias has associated an LID to it. */
  canonicalJid(jid) {
    let current = normalizeJid(jid);
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const row = this.db.prepare('SELECT canonical_jid FROM contact_aliases WHERE alias_jid = ?').get(current);
      const next = normalizeJid(row?.canonical_jid);
      if (!next || next === current) break;
      current = next;
    }
    return current;
  }

  /** Owner-entered names override all synced/profile labels without storing a secret. */
  setManualName(jid, name) {
    const target = this.canonicalJid(jid);
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!target) throw new Error('enter a WhatsApp contact number or JID');
    if (!clean || clean.length > 120) throw new Error('name must contain 1–120 characters');
    const phone = jidToPhone(target);
    const info = phone ? resolvePhone(phone) : null;
    this.db.prepare(
      `INSERT INTO contacts(jid, manual_name, phone_e164, country_iso, country_name, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET manual_name = excluded.manual_name, last_seen = excluded.last_seen`
    ).run(target, clean, info?.e164 || null, info?.countryIso || null, info?.countryName || null, Date.now());
    this.mem.delete(target);
    return { jid: target, name: clean };
  }

  clearManualName(jid) {
    const target = this.canonicalJid(jid);
    if (!target) return false;
    const result = this.db.prepare('UPDATE contacts SET manual_name = NULL WHERE jid = ?').run(target);
    this.mem.delete(target);
    return Boolean(result.changes);
  }

  get(jid) {
    const j = this.canonicalJid(jid);
    if (this.mem.has(j)) return this.mem.get(j);
    const row = this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(j) || null;
    if (row) this.mem.set(j, row);
    return row;
  }

  #recordsFor(jid) {
    const requested = normalizeJid(jid);
    const canonical = this.canonicalJid(requested);
    const aliases = canonical
      ? this.db.prepare('SELECT alias_jid FROM contact_aliases WHERE canonical_jid = ?').all(canonical).map((row) => row.alias_jid)
      : [];
    const rows = [];
    for (const id of uniqueJids([canonical, requested, ...aliases])) {
      const row = this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(id);
      if (row) rows.push(row);
    }
    return { canonical, ids: uniqueJids([canonical, requested, ...aliases]), rows };
  }

  /**
   * Best human label for a JID, most personal first.
   * @returns {{name:string, source:'manual'|'local'|'notify'|'verified'|'phone'|'jid'}}
   */
  displayName(jid, fallback = null) {
    const { ids, rows } = this.#recordsFor(jid);
    const manual = rows.map((row) => row.manual_name).find(Boolean);
    if (manual) return { name: manual, source: 'manual' };
    const local = rows.map((row) => row.local_name).find(Boolean);
    if (local) return { name: local, source: 'local' };
    const verified = rows.map((row) => row.verified_name).find(Boolean);
    if (verified) return { name: verified, source: 'verified' };
    const notify = rows.map((row) => row.notify_name).find(Boolean);
    if (notify) return { name: notify, source: 'notify' };
    const phone = ids.map(jidToPhone).find(Boolean);
    if (phone) return { name: `+${phone}`, source: 'phone' };
    return { name: fallback || normalizeJid(jid), source: 'jid' };
  }

  /** Full profile used by alerts, reports, and command responses. */
  profile(jid, ...observedAliases) {
    // The alias is only stored when it was explicitly supplied by WhatsApp in
    // this event; an LID is never reverse-engineered into a phone number.
    if (observedAliases.filter(Boolean).length) this.linkAliases(jid, ...observedAliases);
    const { canonical, ids, rows } = this.#recordsFor(jid);
    const c = rows.find((row) => row.jid === canonical) || rows[0] || {};
    const phone = rows.map((row) => row.phone_e164).find(Boolean) || ids.map(jidToPhone).find(Boolean) || null;
    const info = phone ? resolvePhone(phone) : null;
    const { name, source } = this.displayName(canonical || jid);
    return {
      jid: canonical || normalizeJid(jid),
      aliases: ids,
      name,
      nameSource: source,
      manualName: rows.map((row) => row.manual_name).find(Boolean) || null,
      localName: rows.map((row) => row.local_name).find(Boolean) || null,
      notifyName: rows.map((row) => row.notify_name).find(Boolean) || null,
      phoneE164: info?.e164 || phone || null,
      phoneNational: info?.national || null,
      countryIso: c.country_iso || info?.countryIso || null,
      countryName: c.country_name || info?.countryName || null,
      numberValid: info?.valid ?? false,
      numberType: info?.type || null,
    };
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  }

  /**
   * Resolve a saved address-book name without silently choosing a non-exact
   * result. Exact local-name matches come first; otherwise callers receive a
   * small, ranked list of partial/nearby names and can ask the owner to choose.
   */
  findByName(query) {
    const nameKey = (value) => String(value || '')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase();
    const distance = (left, right) => {
      const a = [...left];
      const b = [...right];
      const row = Array.from({ length: b.length + 1 }, (_, i) => i);
      for (let i = 1; i <= a.length; i++) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
          const saved = row[j];
          row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
          previous = saved;
        }
      }
      return row[b.length];
    };

    const needle = nameKey(query);
    if (!needle) return [];
    const rows = this.db
      .prepare(
        `SELECT jid, manual_name, local_name, notify_name, verified_name, phone_e164
           FROM contacts
          WHERE (manual_name IS NOT NULL AND manual_name <> '')
             OR (local_name IS NOT NULL AND local_name <> '')
          ORDER BY CASE WHEN manual_name IS NOT NULL AND manual_name <> '' THEN 0 ELSE 1 END, manual_name, local_name`
      )
      .all()
      .map((row) => ({
        ...row,
        jid: this.canonicalJid(row.jid),
        // Manual names take precedence even during targeting, not merely when
        // an alert is displayed.
        local_name: contactName(row),
        key: nameKey(contactName(row)),
      }))
      .filter((row, index, all) => all.findIndex((other) => other.jid === row.jid && other.key === row.key) === index);

    const exact = rows.filter((row) => row.key === needle);
    if (exact.length) return exact.map(({ key, ...row }) => ({ ...row, matchType: 'exact' }));

    const partial = rows.filter((row) => row.key.includes(needle) || needle.includes(row.key));
    if (partial.length) {
      return partial.map(({ key, ...row }) => ({ ...row, matchType: 'partial' }));
    }

    // A typo should offer a choice, not force the controller to remember the
    // precise saved spelling. Keep the threshold conservative to avoid dumping
    // an unrelated address book into a command response.
    return rows
      .map((row) => ({ ...row, distance: distance(needle, row.key) }))
      .filter((row) => row.distance <= Math.max(1, Math.floor(Math.max(needle.length, row.key.length) / 3)))
      .sort((a, b) => a.distance - b.distance || a.local_name.localeCompare(b.local_name))
      .slice(0, 8)
      .map(({ key, distance: _distance, ...row }) => ({ ...row, matchType: 'similar' }));
  }

  /** Contacts that have a synced or owner-entered name. */
  named() {
    return this.db
      .prepare(
        `SELECT jid, manual_name, local_name, notify_name, country_name
           FROM contacts
          WHERE (manual_name IS NOT NULL AND manual_name <> '')
             OR (local_name IS NOT NULL AND local_name <> '')
          ORDER BY CASE WHEN manual_name IS NOT NULL AND manual_name <> '' THEN 0 ELSE 1 END, manual_name, local_name
          LIMIT 500`
      )
      .all()
      .map((row) => ({ ...row, jid: this.canonicalJid(row.jid), local_name: contactName(row) }));
  }
}

export default ContactStore;
