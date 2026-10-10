/**
 * Nexus-WA — Fake WhatsApp transport (the preview harness).
 *
 * Implements the SAME surface as a Baileys socket that plugins actually touch:
 *   sendMessage, sendPresenceUpdate, presenceSubscribe, readMessages,
 *   downloadMediaMessage, user, and the EventEmitter 'messages.upsert'.
 *
 * Nothing here opens a network connection. There is no WhatsApp server, no
 * auth handshake, no pairing code — so there is literally zero ban risk.
 *
 * Everything a plugin sends is recorded in `outbox` and echoed to the console,
 * so you can watch the bot's behaviour before it has ever spoken to Meta.
 */

import { EventEmitter } from 'node:events';
import { normalizeJid } from './jid.js';

let seq = 0;
const nextId = () => `MOCK${Date.now().toString(36).toUpperCase()}${(seq++).toString(36)}`;

/** JID of the simulated owner. Matches the real DM JID format exactly. */
export const MOCK_OWNER_JID = '15550001111@s.whatsapp.net';
export const MOCK_GROUP_JID = '120363000000000000@g.us';

export class MockWhatsAppSocket extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./logger.js').ReturnType} opts.logger
   * @param {string} [opts.ownerJid]
   */
  constructor({ logger, ownerJid = MOCK_OWNER_JID, botJid = '15550009999@s.whatsapp.net' } = {}) {
    super();
    this.setMaxListeners(0);
    this.logger = logger?.child?.({ scope: 'mock-socket' }) || logger;
    this.ownerJid = ownerJid;

    /** Mirrors `sock.user` on a real Baileys socket. */
    this.user = { id: normalizeJid(botJid), name: 'Nexus-WA' };
    this.type = 'mock';
    this.connected = false;

    /** Every outbound message the bot produces, in order. */
    this.outbox = [];
    /** Every presence/read side-effect, for asserting human-like pacing. */
    this.signals = [];
    /** Mock chat-level unread counts, mirroring synced chats.update events. */
    this.unreadCounts = new Map();
  }

  // ── Baileys lifecycle surface ────────────────────────────────────
  async connect() {
    this.connected = true;
    this.emit('connection.update', { connection: 'open', isNewLogin: true, qr: undefined });
    this.logger.info('fake socket "connected" (no network involved)');
  }

  async logout() {
    this.connected = false;
    this.emit('connection.update', { connection: 'close' });
  }

  async end() {
    await this.logout();
  }

  // ── Baileys messaging surface ────────────────────────────────────
  /**
   * Mirrors sock.sendMessage(jid, content, options).
   * `content` is `{ text }`, `{ image, caption }`, `{ audio, mimetype }`, …
   */
  async sendMessage(jid, content = {}, options = {}) {
    const entry = {
      jid,
      kind: Object.keys(content).find((k) => k !== 'mimetype') || 'text',
      text: content.text ?? content.caption ?? '',
      caption: content.caption ?? null,
      quoted: options.quoted ? true : false,
      at: new Date().toISOString(),
    };
    this.outbox.push(entry);

    const target =
      jid === MOCK_GROUP_JID ? 'group' : jid === this.ownerJid ? 'you' : jid.split('@')[0];
    const body = entry.text || `[${entry.kind} message]`;
    this.logger.info(`→ ${target}: ${body.replace(/\n/g, ' ⏎ ')}`);

    // Simulate Baileys returning a key with an id.
    return { key: { remoteJid: jid, fromMe: true, id: nextId() }, message: content };
  }

  async sendPresenceUpdate(presence, jid) {
    this.signals.push({ type: 'presence', presence, jid, at: Date.now() });
    if (presence === 'composing') this.logger.debug(`   …typing to ${jid}`);
  }

  async presenceSubscribe(jid) {
    this.signals.push({ type: 'subscribe', jid, at: Date.now() });
  }

  async readMessages() {
    this.signals.push({ type: 'read', at: Date.now() });
  }

  async downloadMediaMessage(msg) {
    // Real implementation streams bytes. Here we return a marker buffer so
    // media plugins can be exercised without a network fetch.
    return Buffer.from('mock-media-bytes');
  }

  // ── Test-driving helpers (mock only, never on the real socket) ───

  /**
   * Emit an event and await every async listener, so the harness (and tests)
   * can be deterministic. A real Baileys socket is fire-and-forget; the
   * difference is invisible to plugins, which never see this method.
   */
  async #emitSettled(event, payload) {
    const inflight = [];
    for (const listener of this.listeners(event)) {
      try {
        const r = listener(payload);
        if (r && typeof r.then === 'function') inflight.push(r);
      } catch (err) {
        this.logger.error(`listener error: ${err.stack || err.message}`);
      }
    }
    await Promise.all(inflight);
  }

  /**
   * Inject an inbound message exactly as Baileys would deliver it.
   * Resolves once every plugin handler for it has finished.
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.from]     sender JID
   * @param {string} [opts.jid]      chat JID
   * @param {string} [opts.pushName]
   * @param {boolean} [opts.fromMe]
   * @param {object} [opts.media]    e.g. { audioMessage: { mimetype, seconds } }
   * @param {boolean} [opts.viewOnce] wrap in viewOnceMessageV2, as WhatsApp does
   * @returns {Promise<object>} the raw Baileys-shaped message
   */
  async inject(text, opts = {}) {
    const isGroup = (opts.jid || '').endsWith('@g.us');
    const sender = opts.from || (isGroup ? '15550002222@s.whatsapp.net' : this.ownerJid);
    // In a DM the chat JID *is* the other party's JID. Getting this wrong
    // makes every injected stranger normalise back to the owner, which would
    // silently disable the authorisation gate during preview.
    const chatJid = opts.jid || (isGroup ? MOCK_GROUP_JID : sender);

    // Build the inner payload first, then wrap it if this is view-once — the
    // envelope is what the normaliser has to see through.
    let inner;
    if (opts.media) {
      const key = Object.keys(opts.media)[0];
      inner = { [key]: { ...opts.media[key], ...(text ? { caption: text } : {}) } };
    } else {
      inner = { conversation: text };
    }
    if (opts.viewOnce) inner = { viewOnceMessageV2: { message: inner } };

    const raw = {
      key: {
        remoteJid: chatJid,
        fromMe: Boolean(opts.fromMe),
        id: nextId(),
        participant: isGroup ? sender : undefined,
      },
      pushName: opts.pushName || (sender === this.ownerJid ? 'Owner' : 'Stranger'),
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: inner,
    };

    this.logger.info(`← ${raw.pushName}: ${text}${opts.viewOnce ? ' 👁(view-once)' : ''}`);
    await this.#emitSettled('messages.upsert', { messages: [raw], type: 'notify' });
    if (!raw.key.fromMe) {
      const unreadCount = (this.unreadCounts.get(chatJid) || 0) + 1;
      this.unreadCounts.set(chatJid, unreadCount);
      await this.#emitSettled('chats.update', [{ id: chatJid, unreadCount }]);
    }
    return raw;
  }

  /** Explicitly change a mock chat unread count to model WhatsApp sync. */
  async setUnreadCount(jid, unreadCount) {
    const chatJid = normalizeJid(jid);
    this.unreadCounts.set(chatJid, unreadCount);
    await this.#emitSettled('chats.update', [{ id: chatJid, unreadCount }]);
  }

  /** Convenience: inject into a simulated group chat. */
  async injectGroup(text, opts = {}) {
    return this.inject(text, { ...opts, jid: MOCK_GROUP_JID });
  }

  /**
   * Emit a revoke exactly as WhatsApp does: a `messages.update` carrying a
   * protocolMessage of type REVOKE that names the deleted stanza id.
   *
   * @param {string} stanzaId  id of the message being deleted
   * @param {object} [opts]    { from, jid, fromMe }
   */
  async injectRevoke(stanzaId, opts = {}) {
    const isGroup = (opts.jid || '').endsWith('@g.us');
    const sender = opts.from || (isGroup ? '15550002222@s.whatsapp.net' : this.ownerJid);
    const chatJid = opts.jid || (isGroup ? MOCK_GROUP_JID : sender);

    const update = {
      key: {
        remoteJid: chatJid,
        fromMe: Boolean(opts.fromMe),
        id: nextId(),
        participant: isGroup ? sender : undefined,
      },
      update: {
        message: {
          protocolMessage: {
            type: 0, // WAProto.Message.ProtocolMessage.Type.REVOKE
            stanzaId,
          },
        },
      },
    };

    this.logger.info(`← ${sender.split('@')[0]} deleted a message (${stanzaId})`);
    await this.#emitSettled('messages.update', [update]);
    return update;
  }

  /**
   * Emit an edit as WhatsApp does: a messages.update carrying a
   * protocolMessage of type MESSAGE_EDIT (14) with the new content inline.
   */
  async injectEdit(stanzaId, newText, opts = {}) {
    const isGroup = (opts.jid || '').endsWith('@g.us');
    const sender = opts.from || (isGroup ? '15550002222@s.whatsapp.net' : this.ownerJid);
    const chatJid = opts.jid || (isGroup ? MOCK_GROUP_JID : sender);

    const update = {
      key: {
        remoteJid: chatJid,
        fromMe: Boolean(opts.fromMe),
        id: nextId(),
        participant: isGroup ? sender : undefined,
      },
      update: {
        message: {
          protocolMessage: {
            type: 14, // WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            stanzaId,
            editedMessage: { conversation: newText },
          },
        },
      },
    };

    this.logger.info(`← ${sender.split('@')[0]} edited a message (${stanzaId})`);
    await this.#emitSettled('messages.update', [update]);
    return update;
  }

  /**
   * Emit a presence update as Baileys does:
   * { id: <chat jid>, presences: { [participant]: 'available' | 'composing' | … } }
   */
  async injectPresence(jid, state = 'available') {
    const isGroup = (jid || '').endsWith('@g.us');
    const participant = isGroup ? '15550002222@s.whatsapp.net' : jid;
    const payload = { id: jid, presences: { [participant]: state } };
    this.logger.info(`← presence ${participant.split('@')[0]} = ${state}`);
    await this.#emitSettled('presence.update', payload);
    return payload;
  }

  /**
   * Emit a group membership stub (join/leave/promote/demote).
   */
  async injectGroupEvent(kind, { groupJid = MOCK_GROUP_JID, participants = [] } = {}) {
    const STUB = {
      created: 20, joined: 27, left: 28, promoted: 29, demoted: 30,
    };
    const raw = {
      key: { remoteJid: groupJid, fromMe: false, id: nextId() },
      messageStubType: STUB[kind] ?? kind,
      participants,
      messageTimestamp: Math.floor(Date.now() / 1000),
    };
    this.logger.info(`← group event ${kind} (${participants.length})`);
    await this.#emitSettled('messages.upsert', { messages: [raw], type: 'notify' });
    return raw;
  }
}

export default MockWhatsAppSocket;
