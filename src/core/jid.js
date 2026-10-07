/**
 * Nexus-WA — JID and phone-number helpers.
 *
 * Baileys v7 dropped `jidNormalized` and the built-in contact store, so the
 * bits we relied on live here instead. Everything that turns a JID into
 * something a human recognises (E.164 number, country, display name) is in
 * this one module, so the dashboard, the anti-delete notifier and the CLI all
 * agree on formatting.
 */

import { parsePhoneNumber } from 'libphonenumber-js';
import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };

countries.registerLocale(en);

const S_WHATSAPP = '@s.whatsapp.net';
const G_US = '@g.us';
const NEWSLETTER = '@newsletter';
const LID = '@lid';

/**
 * Strip the device suffix and lowercase.
 *
 * Baileys device JIDs look like `12025550188:12@s.whatsapp.net` — the colon
 * comes BEFORE the domain, so a naive `split(':')[0]` throws the domain away
 * and yields `12025550188`, which is not a valid JID. Split on the local part
 * only.
 */
export function normalizeJid(jid) {
  if (!jid) return '';
  const s = String(jid).trim().toLowerCase();
  const at = s.indexOf('@');
  const local = at === -1 ? s : s.slice(0, at);
  const domain = at === -1 ? '' : s.slice(at);
  return local.split(':')[0] + domain;
}

export function isGroupJid(jid) {
  return normalizeJid(jid).endsWith(G_US);
}
export function isNewsletterJid(jid) {
  return normalizeJid(jid).endsWith(NEWSLETTER);
}
export function isLidJid(jid) {
  return normalizeJid(jid).endsWith(LID);
}
/** A 1:1 chat (not a group, channel or address-book id). */
export function isUserJid(jid) {
  return normalizeJid(jid).endsWith(S_WHATSAPP);
}

/** `15551234567@s.whatsapp.net` -> `15551234567` (empty for non-user JIDs). */
export function jidToPhone(jid) {
  const n = normalizeJid(jid);
  if (!isUserJid(n)) return '';
  return n.split('@')[0];
}

/** `15551234567` -> `15551234567@s.whatsapp.net`. Accepts +, spaces, dashes. */
export function phoneToJid(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `${digits}${S_WHATSAPP}` : '';
}

export function isSelfJid(jid, myJid) {
  if (!myJid) return false;
  const a = jidToPhone(jid);
  const b = jidToPhone(myJid);
  return Boolean(a && b && a === b);
}

/**
 * Resolve a phone string or JID into structured location data.
 * Never throws — an unrecognisable number yields valid:false rather than a
 * crash, because WhatsApp hands us plenty of odd JIDs (LIDs, groups, test
 * ranges like the 1-555 numbers used in this repo's mocks).
 */
export function resolvePhone(input) {
  const s = String(input ?? '');
  // Anything with an @ is a JID. Only 1:1 JIDs carry a phone number — feeding
  // a group's numeric id (`120363…@g.us`) into the phone parser would invent a
  // country for a chat that has no number at all.
  const digits = s.includes('@')
    ? isUserJid(s)
      ? jidToPhone(s)
      : ''
    : s.replace(/\D/g, '');

  const base = {
    digits,
    e164: digits ? `+${digits}` : '',
    national: '',
    countryIso: null,
    countryName: null,
    valid: false,
    type: null,
  };
  if (!digits) return base;

  try {
    const p = parsePhoneNumber(`+${digits}`);
    if (!p) return base;
    const iso = p.country || null;
    return {
      ...base,
      e164: p.number || base.e164,
      national: p.formatNational(),
      countryIso: iso,
      countryName: iso ? countries.getName(iso, 'en') || iso : null,
      valid: Boolean(p.isValid()),
      type: p.getType() || null,
    };
  } catch {
    return base;
  }
}

/** Short label for a chat, e.g. "You", "Mom", "120363…@g.us". */
export function describeChat(jid, { myJid, name } = {}) {
  const n = normalizeJid(jid);
  if (isSelfJid(n, myJid)) return 'You';
  if (name) return name;
  if (isGroupJid(n)) return `group ${n.split('@')[0].slice(-6)}…`;
  if (isNewsletterJid(n)) return 'channel';
  const phone = jidToPhone(n);
  return phone ? `+${phone}` : n;
}

export default {
  normalizeJid,
  isGroupJid,
  isUserJid,
  isNewsletterJid,
  isLidJid,
  jidToPhone,
  phoneToJid,
  isSelfJid,
  resolvePhone,
  describeChat,
};
