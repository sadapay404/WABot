/**
 * Nexus-WA — encrypted session backup.
 *
 * Free-tier PaaS boxes have EPHEMERAL filesystems: the container is replaced on
 * every deploy, and with it `data/auth` — your WhatsApp link — and `nexus.db`.
 * Without a backup you silently get logged out and lose all history.
 *
 * This writes one encrypted blob containing both, so a redeploy is a restore
 * instead of a re-link.
 *
 * What is in the blob, stated plainly: your WhatsApp identity keypair. Anyone
 * who can read that file can impersonate your session until it is revoked. It
 * is therefore encrypted with AES-256-GCM under a key derived from your
 * passphrase with scrypt, and the passphrase is never stored — only a salt.
 * Lose the passphrase and the backup is unrecoverable, which is the correct
 * trade for material this sensitive.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MAGIC = 'NEXWA1';

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
}

export class SessionBackup {
  /**
   * @param {object} deps
   * @param {object} deps.logger
   * @param {string} deps.sessionDir  where Baileys credentials live
   * @param {string} deps.dbPath
   * @param {string} [deps.dir]       where backups are written
   */
  constructor({ logger, sessionDir, dbPath, dir }) {
    this.logger = logger.child({ scope: 'backup' });
    this.sessionDir = sessionDir;
    this.dbPath = dbPath;
    this.dir = dir || path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Create a backup.
   * @param {string} passphrase
   * @returns {{file:string, bytes:number, sessions:number}}
   */
  create(passphrase) {
    if (!passphrase || String(passphrase).length < 8) {
      throw new Error('backup passphrase must be at least 8 characters');
    }

    const payload = {
      createdAt: Date.now(),
      session: this.#readSession(),
      db: fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath).toString('base64') : null,
    };

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);

    const file = path.join(
      this.dir,
      `nexus-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.nwb`
    );
    const blob = Buffer.concat([
      Buffer.from(MAGIC, 'utf8'),
      salt,
      iv,
      cipher.getAuthTag(),
      enc,
    ]);
    fs.writeFileSync(file, blob);

    this.logger.info(`wrote encrypted backup (${blob.length} bytes) → ${file}`);
    return { file, bytes: blob.length, sessions: payload.session.length };
  }

  #readSession() {
    if (!fs.existsSync(this.sessionDir)) return [];
    const out = [];
    const walk = (dir, rel = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, relPath);
        else out.push({ path: relPath, data: fs.readFileSync(full).toString('base64') });
      }
    };
    walk(this.sessionDir);
    return out;
  }

  /**
   * Restore a backup. Destructive: existing credentials are replaced.
   * @returns {{sessions:number, db:boolean}}
   */
  restore(file, passphrase) {
    return this.restoreBuffer(fs.readFileSync(file), passphrase, path.basename(file));
  }

  /** Read a backup blob off disk without decrypting it. */
  readFile(file) {
    return fs.readFileSync(file);
  }

  /**
   * Delete a local backup file. Used after a successful remote push so the
   * plaintext-adjacent blob is not left sitting on an ephemeral disk.
   */
  discard(file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }

  /**
   * Restore straight from an in-memory blob — the path the remote vault uses,
   * where the backup never needs to touch the local filesystem.
   * @returns {{sessions:number, db:boolean}}
   */
  restoreBuffer(blob, passphrase, label = 'remote') {
    if (!Buffer.isBuffer(blob) || blob.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) {
      throw new Error('not a Nexus-WA backup file');
    }
    let off = MAGIC.length;
    const salt = blob.subarray(off, (off += 16));
    const iv = blob.subarray(off, (off += 12));
    const tag = blob.subarray(off, (off += 16));
    const enc = blob.subarray(off);

    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    let payload;
    try {
      payload = JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8'));
    } catch {
      // A GCM auth failure and a wrong passphrase look identical, on purpose.
      throw new Error('could not decrypt — wrong passphrase, or the file is corrupt');
    }

    fs.rmSync(this.sessionDir, { recursive: true, force: true });
    fs.mkdirSync(this.sessionDir, { recursive: true });
    for (const f of payload.session || []) {
      const dest = path.join(this.sessionDir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(f.data, 'base64'));
    }

    let db = false;
    if (payload.db) {
      fs.writeFileSync(this.dbPath, Buffer.from(payload.db, 'base64'));
      db = true;
    }

    this.logger.info(`restored ${(payload.session || []).length} session file(s) from ${label}`);
    return { sessions: (payload.session || []).length, db };
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.nwb'))
      .map((f) => {
        const st = fs.statSync(path.join(this.dir, f));
        return { file: path.join(this.dir, f), name: f, bytes: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  }
}

export default SessionBackup;
