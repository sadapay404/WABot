/**
 * Read-only lookups for the owner's `.receive` command.
 *
 * Unread status is sourced only from Baileys' synced chat-level unreadCount.
 * This service never calls readMessages/markChatAsRead and does not infer an
 * unread state from the age of a cached message.
 */

import { normalizeJid } from './jid.js';

export class MessageInbox {
  constructor({ db, cache, mediaStore, socket, logger, downloader = null, now = () => Date.now() }) {
    this.db = db;
    this.cache = cache;
    this.mediaStore = mediaStore;
    this.socket = socket;
    this.logger = logger.child({ scope: 'message-inbox' });
    this.downloader = downloader;
    this.now = now;
    this.stats = { chatUpdates: 0, mediaReads: 0, mediaMisses: 0 };
  }

  /** Persist only explicit numeric unreadCount updates from WhatsApp. */
  syncChats(chats = []) {
    if (!Array.isArray(chats)) return 0;
    const save = this.db.prepare(
      `INSERT INTO inbox_chat_state(chat_jid, unread_count, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_jid) DO UPDATE SET
         unread_count = excluded.unread_count,
         updated_at = excluded.updated_at`
    );
    let updated = 0;
    for (const chat of chats) {
      const jid = normalizeJid(chat?.id || chat?.jid || '');
      if (!jid || typeof chat?.unreadCount !== 'number' || !Number.isInteger(chat.unreadCount)) continue;
      save.run(jid, chat.unreadCount, this.now());
      updated++;
    }
    this.stats.chatUpdates += updated;
    return updated;
  }

  unreadChats({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return this.db.prepare(
      `SELECT chat_jid, unread_count, updated_at
         FROM inbox_chat_state
        WHERE unread_count > 0
        ORDER BY updated_at DESC
        LIMIT ?`
    ).all(safeLimit);
  }

  unreadChatCount() {
    return this.db.prepare(
      'SELECT COUNT(*) AS count FROM inbox_chat_state WHERE unread_count > 0'
    ).get().count;
  }

  unknownUnreadCount() {
    return this.db.prepare(
      'SELECT COUNT(*) AS count FROM inbox_chat_state WHERE unread_count < 0'
    ).get().count;
  }

  /** Resolve an explicitly selected number/JID to its cached direct chat. */
  findChats(value) {
    const jid = normalizeJid(value);
    if (!jid) return [];
    return this.db.prepare(
      `SELECT chat_jid, MAX(chat_jid_alt) AS chat_jid_alt, MAX(ts) AS last_at
         FROM message_cache
        WHERE chat_jid = ? OR chat_jid_alt = ?
        GROUP BY chat_jid
        ORDER BY last_at DESC
        LIMIT 3`
    ).all(jid, jid);
  }

  /** Recent inbound cache rows, oldest first for readable chronological output. */
  messages(chatJid, { altJid = null, limit = 10 } = {}) {
    const jid = normalizeJid(chatJid);
    const alt = altJid ? normalizeJid(altJid) : null;
    const safeLimit = Math.max(1, Math.min(Number(limit) || 1, 500));
    return this.db.prepare(
      `SELECT * FROM message_cache
        WHERE (chat_jid = ? OR (? IS NOT NULL AND chat_jid_alt = ?))
        ORDER BY ts DESC
        LIMIT ?`
    ).all(jid, alt, alt, safeLimit).reverse();
  }

  /** Return media bytes only when cached raw data or a local archive has them. */
  async readMedia(record) {
    if (!record?.has_media) return null;

    if (record.view_once) {
      const archived = this.db.prepare(
        `SELECT media_path FROM view_once
          WHERE stanza_id = ? AND media_path IS NOT NULL
          ORDER BY id DESC LIMIT 1`
      ).get(record.id);
      const buffer = archived?.media_path ? this.mediaStore?.read(archived.media_path) : null;
      if (buffer?.length) {
        this.stats.mediaReads++;
        return buffer;
      }
      this.stats.mediaMisses++;
      return null;
    }

    const raw = this.cache?.getRaw?.(record.id);
    if (raw) {
      try {
        const buffer = this.downloader
          ? await this.downloader(raw)
          : await this.#download(raw);
        if (buffer?.length) {
          this.stats.mediaReads++;
          return buffer;
        }
      } catch (error) {
        this.logger.warn(`could not retrieve media for ${record.id}: ${error.message}`);
      }
    }

    // A local media archive may contain a matching capture even after the raw
    // message cache has expired. It stays on this machine; no external upload.
    const archived = this.db.prepare(
      'SELECT path FROM media_archive WHERE stanza_id = ? ORDER BY id DESC LIMIT 1'
    ).get(record.id);
    const buffer = archived?.path ? this.mediaStore?.read(archived.path) : null;
    if (buffer?.length) {
      this.stats.mediaReads++;
      return buffer;
    }

    this.stats.mediaMisses++;
    return null;
  }

  async #download(raw) {
    // Baileys exposes the media downloader as a package utility, not on the
    // socket. Do not touch message receipts while fetching bytes.
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    const context = { logger: this.logger };
    if (typeof this.socket?.updateMediaMessage === 'function') {
      context.reuploadRequest = (message) => this.socket.updateMediaMessage(message);
    }
    return downloadMediaMessage(raw, 'buffer', {}, context);
  }
}

export default MessageInbox;
