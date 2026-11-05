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
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const MAX_SESSION_FILES = 10_000;

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
   * @param {object} [deps.db]         open driver-agnostic SQLite handle
   */
  constructor({ logger, sessionDir, dbPath, dir, db = null }) {
    this.logger = logger.child({ scope: 'backup' });
    this.sessionDir = sessionDir;
    this.dbPath = dbPath;
    this.dir = dir || path.join(path.dirname(dbPath), 'backups');
    this.db = db;
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

    const snapshot = this.#readDatabaseFiles();
    const payload = {
      createdAt: Date.now(),
      session: this.#readSession(),
      // SQLite WAL commits do not necessarily appear in the main file. Keep
      // matching sidecars so a restore before opening SQLite sees the same
      // committed state rather than silently rolling it back.
      db: snapshot.main,
      dbWal: snapshot.wal,
      dbShm: snapshot.shm,
    };

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);

    const file = path.join(
      this.dir,
      `nexus-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${process.pid}-${crypto.randomUUID()}.nwb`
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

  #readDatabaseFiles() {
    if (this.db?.prepare) {
      // A successful truncate checkpoint gives us one coherent main DB. Never
      // silently create a main-file-only backup if SQLite says readers kept
      // WAL pages pinned; callers can retry after the workload settles.
      const rows = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
      const result = Array.isArray(rows) ? rows[0] : rows;
      if (Number(result?.busy || 0) !== 0) throw new Error('SQLite checkpoint is busy; backup was not created');
    }
    const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null);
    // Legacy/manual callers without an open DB handle retain matching WAL/SHM
    // sidecars. Runtime construction supplies the handle above for a verified
    // checkpointed snapshot.
    return { main: read(this.dbPath), wal: read(`${this.dbPath}-wal`), shm: read(`${this.dbPath}-shm`) };
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
    if (!Buffer.isBuffer(blob) || blob.length > MAX_BACKUP_BYTES || blob.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) {
      throw new Error('not a Nexus-WA backup file');
    }
    let off = MAGIC.length;
    if (blob.length < off + 16 + 12 + 16) throw new Error('not a Nexus-WA backup file');
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
      throw new Error('could not decrypt — wrong passphrase, or the file is corrupt');
    }
    const session = Array.isArray(payload?.session) ? payload.session : null;
    if (!session || session.length > MAX_SESSION_FILES) throw new Error('backup payload has invalid session entries');

    // Validate everything before touching either destination. Session paths are
    // archive-like untrusted data even after authentication: keep them beneath
    // the configured root and cap decoded values.
    const staged = session.map((entry) => {
      const rel = String(entry?.path || '');
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) throw new Error('backup payload has an unsafe session path');
      const data = Buffer.from(String(entry?.data || ''), 'base64');
      if (data.length > MAX_BACKUP_BYTES) throw new Error('backup payload contains an oversized session file');
      return { rel, data };
    });
    const decodeDb = (value, name) => {
      if (value == null) return null;
      const data = Buffer.from(String(value), 'base64');
      if (data.length > MAX_BACKUP_BYTES) throw new Error(`backup payload contains an oversized ${name}`);
      return data;
    };
    const db = decodeDb(payload.db, 'database');
    const wal = decodeDb(payload.dbWal, 'database WAL');
    const shm = decodeDb(payload.dbShm, 'database SHM');

    const parent = path.dirname(this.sessionDir);
    const staging = fs.mkdtempSync(path.join(parent, '.nexus-restore-'));
    try {
      const stagedSession = path.join(staging, 'session');
      fs.mkdirSync(stagedSession, { recursive: true });
      for (const file of staged) {
        const dest = path.resolve(stagedSession, file.rel);
        if (!dest.startsWith(`${stagedSession}${path.sep}`)) throw new Error('backup payload has an unsafe session path');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.data);
      }
      if (db) fs.writeFileSync(path.join(staging, 'database'), db);
      if (wal) fs.writeFileSync(path.join(staging, 'database-wal'), wal);
      if (shm) fs.writeFileSync(path.join(staging, 'database-shm'), shm);

      // This method is only used before the database is opened or by explicit
      // owner restore. Do not delete/replace a destination until validation and
      // staging succeeded.
      fs.rmSync(this.sessionDir, { recursive: true, force: true });
      fs.renameSync(stagedSession, this.sessionDir);
      if (db) {
        fs.writeFileSync(this.dbPath, fs.readFileSync(path.join(staging, 'database')));
        for (const suffix of ['-wal', '-shm']) fs.rmSync(`${this.dbPath}${suffix}`, { force: true });
        if (wal) fs.writeFileSync(`${this.dbPath}-wal`, fs.readFileSync(path.join(staging, 'database-wal')));
        if (shm) fs.writeFileSync(`${this.dbPath}-shm`, fs.readFileSync(path.join(staging, 'database-shm')));
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }

    this.logger.info(`restored ${session.length} session file(s) from ${label}`);
    return { sessions: session.length, db: Boolean(db) };
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
