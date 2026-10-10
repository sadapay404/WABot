/**
 * Shared display helpers for every alert and report: sender with number,
 * chat type, and 12-hour clock times. Kept pure so tests can call them directly.
 */
import { isGroupJid, isNewsletterJid, normalizeJid } from '../core/jid.js';

export const DEFAULT_TZ = 'Asia/Karachi';

// Node may print a narrow no-break space before AM/PM; normal spaces read better in chat.
const plain = (s) => String(s).replace(/[\u00a0\u202f]/g, ' ');

function format(ms, tz, options) {
  const base = { hour12: true, ...options };
  try {
    return plain(new Intl.DateTimeFormat('en-US', { ...base, timeZone: tz || DEFAULT_TZ }).format(new Date(ms)));
  } catch {
    return plain(new Intl.DateTimeFormat('en-US', base).format(new Date(ms)));
  }
}

/** "3:05 PM" */
export function clock12(ms, tz = DEFAULT_TZ) {
  return format(ms, tz, { hour: 'numeric', minute: '2-digit' });
}

/** "Oct 10, 2026, 3:05 PM" */
export function dateTime12(ms, tz = DEFAULT_TZ) {
  return format(ms, tz, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * What kind of conversation a JID is. WhatsApp communities are ordinary groups
 * at the JID level, so they show as "Group" unless group metadata says otherwise.
 */
export function chatKind(jid) {
  const n = normalizeJid(jid);
  if (!n) return 'Chat';
  if (n === 'status@broadcast') return 'Status';
  if (isGroupJid(n)) return 'Group';
  if (isNewsletterJid(n)) return 'Channel';
  return 'Chat';
}

/** "Group: Family" or "Chat: Ali (+923001234567)" */
export function chatTag(jid, label) {
  return `${chatKind(jid)}: ${label || normalizeJid(jid) || 'unknown'}`;
}

/**
 * Sender as "Name (+923001234567)". Always includes the number when it is
 * known, because the name alone can be ambiguous or missing.
 */
export function senderLine(profile = {}) {
  const p = profile || {};
  const phone = p.phoneE164
    ? (String(p.phoneE164).startsWith('+') ? String(p.phoneE164) : `+${p.phoneE164}`)
    : null;
  const name = p.name && p.nameSource !== 'jid' && p.name !== p.phoneE164 && p.name !== phone
    ? p.name
    : null;
  if (name && phone) return `${name} (${phone})`;
  if (phone) return phone;
  if (name) return `${name} (number not known)`;
  return 'unknown sender (number not known)';
}
