/**
 * Nexus-WA — edited-message watch.
 *
 * WhatsApp lets people silently rewrite a message after you have read it. The
 * edit is a MESSAGE_EDIT (14) protocol stanza. Baileys turns it into a
 * messages.update event whose key.id is the original stanza id and whose new
 * content lives under update.message.editedMessage.message.
 *
 * Because the message cache already holds the original text, we can show the
 * diff instead of just "this was edited".
 */

import { normalizeJid, isGroupJid, describeChat } from './jid.js';
import { captureAlertJid } from './alertRouting.js';
import { extractText } from './message.js';
import { flag, setFlag } from '../database/index.js';

const PROTOCOL_MESSAGE_EDIT = 14;

/**
 * Pull an edit out of a Baileys update/upsert payload.
 * @returns {{stanzaId:string, newText:string}|null}
 */
export function extractEdit(payload = {}) {
  const update = payload.update || {};
  const message = update.message || payload.message || null;

  // Baileys emits MESSAGE_EDIT as a normalized messages.update event:
  //   { key: { id: <original stanza id> },
  //     update: { message: { editedMessage: { message: <new content> } } } }
  // The edit is no longer exposed as a protocolMessage here; its key.id is the
  // edited stanza's ID. Keep the protocol form below for older Baileys builds.
  const editedMessage = message?.editedMessage;
  if (editedMessage) {
    const stanzaId = payload.key?.id || update.key?.id || editedMessage.key?.id || null;
    const newText = extractText(editedMessage.message || editedMessage) || null;
    return { stanzaId, newText };
  }

  const proto = message?.protocolMessage;
  if (!proto) return null;
  if (proto.type !== PROTOCOL_MESSAGE_EDIT && proto.type !== 'MESSAGE_EDIT') return null;

  const stanzaId = proto.stanzaId || proto.key?.id || null;
  const newText = extractText(proto.editedMessage) || null;
  return { stanzaId, newText };
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export class EditWatch {
  constructor({ socket, db, cache, contacts, logger, config }) {
    this.socket = socket;
    this.db = db;
    this.cache = cache;
    this.contacts = contacts;
    this.logger = logger.child({ scope: 'edit-watch' });
    this.config = config;
    this.stats = { detected: 0, withDiff: 0, noOriginal: 0, failed: 0 };
  }

  selfJid() {
    const me = this.socket?.user?.id;
    return me ? normalizeJid(me) : null;
  }

  enabled() {
    return flag(this.db, 'editwatch.enabled', true);
  }
  setEnabled(on) {
    setFlag(this.db, 'editwatch.enabled', on);
    return this.enabled();
  }

  /** messages.update stream. */
  async onUpdate(update) {
    const edit = extractEdit(update);
    if (!edit?.stanzaId) return null;
    return this.onEdit(update, edit);
  }

  async onEdit(source, edit) {
    if (!this.enabled()) return null;
    this.stats.detected++;

    const key = source?.key || {};
    const chatJid = normalizeJid(key.remoteJid);
    const senderJid = normalizeJid(
      key.fromMe ? this.selfJid() : isGroupJid(chatJid) ? key.participant || chatJid : chatJid
    );

    const record = this.cache?.getRecord?.(edit.stanzaId) || null;
    const rawOriginal = this.cache?.getRaw?.(edit.stanzaId) || null;
    const before = record?.text ?? (rawOriginal ? extractText(rawOriginal.message) || null : null);
    this.logger.info(`edit event detected${before === null ? ' (original not cached)' : ''}`);
    const profile = this.contacts.profile(senderJid);
    const at = Date.now();

    if (before) this.stats.withDiff++;
    else this.stats.noOriginal++;

    const entry = {
      stanzaId: edit.stanzaId,
      chatJid,
      chatLabel: describeChat(chatJid, {
        myJid: this.selfJid(),
        name: isGroupJid(chatJid) ? null : profile.name,
      }),
      isGroup: isGroupJid(chatJid),
      senderJid,
      profile,
      before,
      after: edit.newText ?? '',
      at,
    };

    this.#persist(entry);

    // Refresh the cache so a second edit diffs against the latest text.
    if (record && edit.newText) {
      this.db
        .prepare('UPDATE message_cache SET text = ? WHERE id = ?')
        .run(edit.newText, edit.stanzaId);
    }

    const destination = captureAlertJid(this.config, this.selfJid());
    if (destination) {
      try {
        await this.socket.sendMessage(destination, { text: formatEdit(entry) });
      } catch (err) {
        this.stats.failed++;
        this.logger.error(`could not send edit alert: ${err.message}`);
      }
    }
    return entry;
  }

  #persist(e) {
    try {
      this.db
        .prepare(
          `INSERT INTO message_edits
             (stanza_id, session_jid, chat_jid, sender_jid, sender_name,
              before_text, after_text, edited_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          e.stanzaId,
          this.selfJid() || '',
          e.chatJid,
          e.senderJid,
          e.profile.name,
          e.before,
          e.after,
          e.at
        );
    } catch (err) {
      this.logger.error(`could not persist edit: ${err.message}`);
    }
  }

  recent(limit = 10) {
    return this.db
      .prepare('SELECT * FROM message_edits ORDER BY edited_at DESC LIMIT ?')
      .all(limit);
  }
}

export function formatEdit(e) {
  const p = e.profile || {};
  const who = [p.name, p.phoneE164 && p.phoneE164 !== p.name ? p.phoneE164 : null]
    .filter(Boolean)
    .join(' · ');

  const lines = ['✏️ *Message edited*', '', `👤 ${who || 'unknown'}`];
  const meta = [p.countryName, e.isGroup ? e.chatLabel : null, clockTime(e.at)].filter(Boolean);
  if (meta.length) lines.push(`ℹ️ ${meta.join(' · ')}`);
  lines.push('');

  if (e.before === null) {
    lines.push('_Original not captured_, so only the new text is known:');
    lines.push(`> ${e.after || '(empty)'}`);
  } else if (e.before === e.after) {
    lines.push('_Edited, but the text is unchanged_ (likely a caption or media swap).');
  } else {
    lines.push('was:');
    for (const l of String(e.before).split('\n')) lines.push(`> ${l}`);
    lines.push('', 'now:');
    for (const l of String(e.after || '(empty)').split('\n')) lines.push(`> ${l}`);
  }

  return lines.join('\n');
}

export default EditWatch;
