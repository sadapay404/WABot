/**
 * Nexus-WA — synthetic demo data.
 *
 * ONLY imported when running in dry-run with an empty database. Its purpose is
 * to let you evaluate the dashboard and the anti-delete output before you link
 * a real number — a completely empty UI tells you nothing about whether the
 * layout works.
 *
 * Every row it writes is clearly marked, and the dashboard shows a permanent
 * "DRY-RUN / synthetic" banner while it is displayed. This module must never
 * run in observe or live mode: `index.js` guards that, and it is asserted in
 * the test suite.
 */

import { normalizeJid, phoneToJid } from '../core/jid.js';

/**
 * All numbers below are syntactically valid, correctly-ranged test numbers,
 * but they belong to no real person. Every one resolves to a real country so
 * the country column, flags and grouping can be evaluated.
 */
const SEED_SESSIONS = [
  { phone: '12025550123', role: 'primary', status: 'active', connects: 14, in: 1843, out: 612, del: 27, daysAgo: 41, notes: 'daily driver' },
  { phone: '447400123456', role: 'burner', status: 'logged_out', connects: 6, in: 210, out: 44, del: 3, daysAgo: 96, notes: 'first test run' },
  { phone: '923001234567', role: 'burner', status: 'retired', connects: 3, in: 88, out: 19, del: 1, daysAgo: 62, notes: 'koyeb soak test' },
  { phone: '6281234567890', role: 'burner', status: 'retired', connects: 2, in: 41, out: 7, del: 0, daysAgo: 30, notes: 'media pipeline test' },
  { phone: '971501234567', role: 'burner', status: 'banned', connects: 9, in: 12, out: 310, del: 0, daysAgo: 20, notes: 'rate-limit experiment — do not repeat' },
];

const SEED_CONTACTS = [
  { phone: '12025550188', local: 'Mom', notify: 'Mom ❤️' },
  { phone: '447400123499', local: 'Dan (work)', notify: 'Daniel' },
  { phone: '919876543210', local: null, notify: 'Priya 🌸' },
  { phone: '61412345678', local: 'Landlord', notify: 'Ray' },
  { phone: '4915112345678', local: null, notify: 'Jonas' },
  { phone: '33612345678', local: 'Camille', notify: 'Cam' },
  { phone: '353851234567', local: null, notify: 'Aoife' },
  { phone: '2348021234567', local: 'Tunde', notify: 'T' },
];

const SEED_DELETIONS = [
  { phone: '12025550188', kind: 'text', text: 'sorry wrong chat, ignore that', minsAgo: 12 },
  { phone: '447400123499', kind: 'text', text: 'can you send the contract by 5?', minsAgo: 74 },
  { phone: '919876543210', kind: 'image', text: null, minsAgo: 190 },
  { phone: '61412345678', kind: 'audio', text: null, minsAgo: 400, mime: 'audio/ogg; codecs=opus' },
  { phone: '12025550188', kind: 'text', text: 'did you tell your brother?', minsAgo: 1500 },
  { phone: '33612345678', kind: 'text', text: 'on my way, 10 min', minsAgo: 2900 },
];

const DAY = 86_400_000;

/**
 * Populate the demo tables.
 * @returns {{sessions:number, contacts:number, deletions:number}}
 */
export function seedDemoData({ db, registry, contacts, selfJid }) {
  const me = normalizeJid(selfJid);
  const now = Date.now();

  for (const s of SEED_SESSIONS) {
    const jid = phoneToJid(s.phone);
    registry.upsert({ jid, pushName: null, role: s.role, notes: s.notes });
    db.prepare(
      `UPDATE sessions
          SET status = ?, connect_count = ?, messages_in = ?, messages_out = ?,
              deletions_seen = ?, first_seen = ?, last_seen = ?
        WHERE jid = ?`
    ).run(
      s.status,
      s.connects,
      s.in,
      s.out,
      s.del,
      now - s.daysAgo * DAY,
      now - Math.max(0, s.daysAgo - 2) * DAY,
      jid
    );
    registry.event(jid, 'connect', 'synthetic demo record');
    if (s.status !== 'active') registry.event(jid, `status:${s.status}`, 'synthetic demo record');
  }

  // Mark whichever seeded number is "you" so the chat label renders as You.
  if (SEED_SESSIONS[0]) {
    db.prepare('UPDATE sessions SET jid = ?, phone_e164 = phone_e164 WHERE jid = ?').run(
      me || phoneToJid(SEED_SESSIONS[0].phone),
      phoneToJid(SEED_SESSIONS[0].phone)
    );
  }

  for (const c of SEED_CONTACTS) {
    contacts.upsert({ id: phoneToJid(c.phone), name: c.local, notify: c.notify });
  }

  for (const d of SEED_DELETIONS) {
    const sender = phoneToJid(d.phone);
    const profile = contacts.profile(sender);
    db.prepare(
      `INSERT INTO deleted_messages
         (stanza_id, session_jid, chat_jid, sender_jid, sender_name, sender_phone,
          sender_country, kind, content, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      `DEMO${d.minsAgo}`,
      me,
      sender,
      sender,
      profile.name,
      profile.phoneE164,
      profile.countryName,
      d.kind,
      d.text,
      now - d.minsAgo * 60_000
    );
  }

  return {
    sessions: SEED_SESSIONS.length,
    contacts: SEED_CONTACTS.length,
    deletions: SEED_DELETIONS.length,
  };
}

export default seedDemoData;
