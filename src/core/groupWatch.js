/**
 * Nexus-WA — group event watch.
 *
 * Group membership changes arrive as stub messages, not normal messages:
 * the payload has `messageStubType` and `participants` instead of `message`.
 * Values verified against baileys 7.0.0-rc14.
 */

import { normalizeJid, isGroupJid } from './jid.js';
import { flag, setFlag } from '../database/index.js';

const STUB = {
  GROUP_CREATE: 20,
  GROUP_PARTICIPANT_ADD: 27,
  GROUP_PARTICIPANT_REMOVE: 28,
  GROUP_PARTICIPANT_PROMOTE: 29,
  GROUP_PARTICIPANT_DEMOTE: 30,
};

const LABEL = {
  [STUB.GROUP_CREATE]: 'created',
  [STUB.GROUP_PARTICIPANT_ADD]: 'joined',
  [STUB.GROUP_PARTICIPANT_REMOVE]: 'left',
  [STUB.GROUP_PARTICIPANT_PROMOTE]: 'promoted to admin',
  [STUB.GROUP_PARTICIPANT_DEMOTE]: 'demoted from admin',
};

/**
 * Classify a stub message.
 * @returns {{kind:string, label:string, participants:string[]}|null}
 */
export function classifyStub(raw = {}) {
  const stub = raw.messageStubType;
  const key = raw.key || {};
  if (!isGroupJid(key.remoteJid)) return null;

  const numeric = typeof stub === 'string' ? STUB[stub] : stub;
  const label = LABEL[numeric];
  if (!label) return null;

  return {
    kind: String(stub),
    label,
    participants: (raw.participants || []).map((p) => normalizeJid(p)),
  };
}

export class GroupWatch {
  constructor({ db, contacts, logger }) {
    this.db = db;
    this.contacts = contacts;
    this.logger = logger.child({ scope: 'group-watch' });
    this.stats = { events: 0, joins: 0, leaves: 0 };
  }

  enabled() {
    return flag(this.db, 'groupwatch.enabled', true);
  }
  setEnabled(on) {
    setFlag(this.db, 'groupwatch.enabled', on);
    return this.enabled();
  }

  /**
   * @returns {object|null} the recorded event
   */
  onMessage(raw) {
    if (!this.enabled()) return null;
    const info = classifyStub(raw);
    if (!info) return null;

    const groupJid = normalizeJid(raw.key.remoteJid);
    const actor = normalizeJid(raw.participant || raw.key.participant || '');
    const groupName =
      raw.messageStubParameters?.[0] ||
      this.contacts.get(groupJid)?.notify_name ||
      null;

    this.db
      .prepare(
        `INSERT INTO group_events(group_jid, group_name, actor_jid, kind, detail, ts)
         VALUES (?,?,?,?,?,?)`
      )
      .run(groupJid, groupName, actor, info.label, (info.participants || []).join(','), Date.now());

    this.stats.events++;
    if (info.label === 'joined') this.stats.joins++;
    if (info.label === 'left') this.stats.leaves++;

    return { groupJid, groupName, actor, ...info };
  }

  /** Render a notification for one event. */
  format(event) {
    const who = event.participants.map((p) => this.contacts.displayName(p).name).join(', ');
    const where = event.groupName || `group ${event.groupJid.split('@')[0].slice(-6)}…`;
    const byWhom = event.actor ? ` (by ${this.contacts.displayName(event.actor).name})` : '';
    return `👥 *${where}* — ${who || 'someone'} ${event.label}${byWhom}`;
  }

  recent(limit = 25, groupJid = null) {
    return groupJid
      ? this.db
          .prepare('SELECT * FROM group_events WHERE group_jid = ? ORDER BY ts DESC LIMIT ?')
          .all(normalizeJid(groupJid), limit)
      : this.db.prepare('SELECT * FROM group_events ORDER BY ts DESC LIMIT ?').all(limit);
  }
}

export default GroupWatch;
