/**
 * Nexus-WA — media archive.
 *
 * WhatsApp media blobs are ephemeral: the URL in a message stops resolving
 * after a while, and view-once media is designed to disappear entirely. Once
 * bytes are in hand they are written to disk and indexed, so a photo someone
 * "un-sent" three weeks ago is still recoverable from the dashboard.
 *
 * Storage is local by design. Cloud sync is a separate concern (see
 * docs/IDEAS.md) and must not silently upload your private media anywhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeJid } from './jid.js';

const EXT = {
  image: 'jpg',
  video: 'mp4',
  audio: 'ogg',
  document: 'bin',
  sticker: 'webp',
};

function extFor(kind, mimetype) {
  if (mimetype?.includes('png')) return 'png';
  if (mimetype?.includes('webp')) return 'webp';
  if (mimetype?.includes('mp4')) return 'mp4';
  if (mimetype?.includes('mpeg')) return 'mp3';
  return EXT[kind] || 'bin';
}

export class MediaStore {
  /**
   * @param {object} deps
   * @param {object} deps.db
   * @param {object} deps.logger
   * @param {string} [deps.dir]  defaults to <root>/data/media
   */
  constructor({ db, logger, dir }) {
    this.db = db;
    this.logger = logger.child({ scope: 'media' });
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Write bytes to disk and index them.
   * @returns {{id:number, path:string, bytes:number}|null}
   */
  save({ buffer, kind = 'image', stanzaId = null, mimetype = null, senderJid = null, chatJid = null }) {
    if (!buffer?.length) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tag = crypto.randomBytes(3).toString('hex');
    const file = path.join(this.dir, `${stamp}-${kind}-${tag}.${extFor(kind, mimetype)}`);

    try {
      fs.writeFileSync(file, buffer);
    } catch (err) {
      this.logger.error(`could not write media to ${file}: ${err.message}`);
      return null;
    }

    const res = this.db
      .prepare(
        `INSERT INTO media_archive(stanza_id, kind, path, bytes, mimetype, sender_jid, chat_jid, archived_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        stanzaId,
        kind,
        file,
        buffer.length,
        mimetype,
        senderJid ? normalizeJid(senderJid) : null,
        chatJid ? normalizeJid(chatJid) : null,
        Date.now()
      );

    this.logger.info(`archived ${kind} (${buffer.length} bytes) → ${file}`);
    return { id: Number(res.lastInsertRowid), path: file, bytes: buffer.length };
  }

  /** Read archived bytes back, or null if the file is gone. */
  read(rowOrPath) {
    const p = typeof rowOrPath === 'string' ? rowOrPath : rowOrPath?.path;
    if (!p || !fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  recent(limit = 20) {
    return this.db
      .prepare('SELECT * FROM media_archive ORDER BY archived_at DESC LIMIT ?')
      .all(limit);
  }

  stats() {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM media_archive')
      .get();
    return { count: row.n, bytes: row.bytes, dir: this.dir };
  }
}

export default MediaStore;
