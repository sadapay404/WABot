/**
 * Nexus-WA — storage layer.
 *
 * Driver strategy: prefer Node's BUILT-IN `node:sqlite` (Node >= 22.5) and
 * fall back to `better-sqlite3` if it is missing. Both expose the same
 * prepare/run/get/all/exec surface, so everything above this file is
 * driver-agnostic.
 *
 * Why the built-in one is the default:
 *   • zero native dependencies — no node-gyp, no compiler, no prebuild
 *     download from GitHub releases. better-sqlite3 failed to build in this
 *     workspace, and that is exactly the failure that breaks free-tier PaaS.
 *   • one less supply-chain surface.
 * `node:sqlite` is flagged experimental; that is the honest trade-off, and the
 * adapter exists so swapping back is a one-line change.
 *
 * FTS5 is required for `.search`. It is probed at boot and, if a build lacks
 * it, `.search` degrades to LIKE matching instead of failing.
 */

import fs from 'node:fs';
import path from 'node:path';

let handle = null;
let fts = false;

const SCHEMA = `
-- ── Identity & sessions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  jid              TEXT    NOT NULL UNIQUE,
  phone_e164       TEXT,
  phone_national   TEXT,
  country_iso      TEXT,
  country_name     TEXT,
  push_name        TEXT,
  role             TEXT    NOT NULL DEFAULT 'burner',
  status           TEXT    NOT NULL DEFAULT 'active',
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER,
  connect_count    INTEGER NOT NULL DEFAULT 0,
  messages_in      INTEGER NOT NULL DEFAULT 0,
  messages_out     INTEGER NOT NULL DEFAULT 0,
  deletions_seen   INTEGER NOT NULL DEFAULT 0,
  notes            TEXT
);

CREATE TABLE IF NOT EXISTS connection_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON connection_events(session_id, ts DESC);

CREATE TABLE IF NOT EXISTS contacts (
  jid           TEXT PRIMARY KEY,
  local_name    TEXT,
  notify_name   TEXT,
  verified_name TEXT,
  phone_e164    TEXT,
  country_iso   TEXT,
  country_name  TEXT,
  last_seen     INTEGER
);

-- ── Message capture ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_cache (
  id             TEXT PRIMARY KEY,
  session_jid    TEXT    NOT NULL,
  chat_jid       TEXT    NOT NULL,
  sender_jid     TEXT,
  kind           TEXT    NOT NULL,
  text           TEXT,
  media_mimetype TEXT,
  media_seconds  INTEGER,
  media_bytes    INTEGER,
  has_media      INTEGER NOT NULL DEFAULT 0,
  view_once      INTEGER NOT NULL DEFAULT 0,
  ts             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_ts   ON message_cache(ts);
CREATE INDEX IF NOT EXISTS idx_cache_chat ON message_cache(chat_jid, ts DESC);

-- Separate transcript for explicit AI questions. Unlike the forensic message
-- cache, it includes both sides of a conversation and is never full-text indexed.
CREATE TABLE IF NOT EXISTS conversation_cache (
  id          TEXT PRIMARY KEY,
  session_jid TEXT NOT NULL,
  chat_jid    TEXT NOT NULL,
  sender_jid  TEXT,
  from_me     INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_chat ON conversation_cache(chat_jid, ts DESC);

CREATE TABLE IF NOT EXISTS deleted_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stanza_id      TEXT,
  session_jid    TEXT    NOT NULL,
  chat_jid       TEXT    NOT NULL,
  sender_jid     TEXT,
  sender_name    TEXT,
  sender_phone   TEXT,
  sender_country TEXT,
  kind           TEXT    NOT NULL,
  content        TEXT,
  media_path     TEXT,
  deleted_at     INTEGER NOT NULL,
  notified       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deleted_ts ON deleted_messages(deleted_at DESC);

CREATE TABLE IF NOT EXISTS view_once (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stanza_id      TEXT,
  session_jid    TEXT    NOT NULL,
  chat_jid       TEXT    NOT NULL,
  sender_jid     TEXT,
  sender_name    TEXT,
  sender_phone   TEXT,
  sender_country TEXT,
  kind           TEXT    NOT NULL,
  caption        TEXT,
  media_path     TEXT,
  media_bytes    INTEGER,
  mimetype       TEXT,
  captured_at    INTEGER NOT NULL,
  forwarded      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vo_ts ON view_once(captured_at DESC);

CREATE TABLE IF NOT EXISTS message_edits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stanza_id    TEXT,
  session_jid  TEXT    NOT NULL,
  chat_jid     TEXT    NOT NULL,
  sender_jid   TEXT,
  sender_name  TEXT,
  before_text  TEXT,
  after_text   TEXT,
  edited_at    INTEGER NOT NULL,
  notified     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_edits_ts ON message_edits(edited_at DESC);

-- ── Observation ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  jid             TEXT PRIMARY KEY,
  name            TEXT,
  status          TEXT,
  photo_id        TEXT,
  blocked_suspect INTEGER NOT NULL DEFAULT 0,
  first_seen      INTEGER,
  last_change     INTEGER
);

CREATE TABLE IF NOT EXISTS profile_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  jid       TEXT    NOT NULL,
  field     TEXT    NOT NULL,
  old_value TEXT,
  new_value TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pev ON profile_events(jid, ts DESC);

CREATE TABLE IF NOT EXISTS presence (
  jid        TEXT PRIMARY KEY,
  state      TEXT,
  last_seen  INTEGER,
  updates    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS presence_log (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  jid  TEXT    NOT NULL,
  state TEXT   NOT NULL,
  ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plog ON presence_log(jid, ts DESC);

CREATE TABLE IF NOT EXISTS group_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_jid  TEXT    NOT NULL,
  group_name TEXT,
  actor_jid  TEXT,
  kind       TEXT    NOT NULL,
  detail     TEXT,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gev ON group_events(group_jid, ts DESC);

-- ── Automation ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  jid        TEXT    NOT NULL,
  text       TEXT,
  run_at     INTEGER,
  cron       TEXT,
  status     TEXT    NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  fired_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);

-- Guided schedule/reminder drafts survive restarts but expire after 24 hours.
CREATE TABLE IF NOT EXISTS schedule_drafts (
  owner_jid  TEXT PRIMARY KEY,
  chat_jid   TEXT NOT NULL,
  state_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_drafts_expiry ON schedule_drafts(expires_at);

CREATE TABLE IF NOT EXISTS triggers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid    TEXT,
  pattern     TEXT    NOT NULL,
  response    TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  match_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT    NOT NULL,
  events      TEXT    NOT NULL DEFAULT '*',
  secret      TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_status INTEGER,
  last_sent   INTEGER,
  -- Failure state is persisted per hook, not just in an in-memory counter:
  -- a hook that has been dead for three days must still say so on .webhook.
  fail_count  INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  actor_jid  TEXT,
  plugin     TEXT,
  action     TEXT    NOT NULL,
  target_jid TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL DEFAULT 'note',
  text       TEXT    NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  remind_at  INTEGER,
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notes ON notes(kind, done, created_at DESC);

CREATE TABLE IF NOT EXISTS media_archive (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stanza_id   TEXT,
  kind        TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  bytes       INTEGER,
  mimetype    TEXT,
  sender_jid  TEXT,
  chat_jid    TEXT,
  archived_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archive_ts ON media_archive(archived_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * FTS5 is a build-time option in SQLite; probe rather than assume.
 *
 * CRITICAL: this is an *external-content* table (content='message_cache'), so
 * FTS5 reads column values back from message_cache using a generated query
 * built from these column names. They must therefore match message_cache's
 * column names exactly. Naming them `sender`/`chat` creates the index fine —
 * MATCH works — but every read of a column value fails at runtime with
 * "no such column: T.sender", where T is FTS5's internal alias for the
 * content table. Hence sender_jid / chat_jid, not sender / chat.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts
  USING fts5(text, sender_jid, chat_jid, content='message_cache', content_rowid='rowid',
             tokenize='porter unicode61');

CREATE TRIGGER IF NOT EXISTS message_fts_ai AFTER INSERT ON message_cache BEGIN
  INSERT INTO message_fts(rowid, text, sender_jid, chat_jid)
  VALUES (new.rowid, new.text, new.sender_jid, new.chat_jid);
END;

CREATE TRIGGER IF NOT EXISTS message_fts_ad AFTER DELETE ON message_cache BEGIN
  INSERT INTO message_fts(message_fts, rowid, text, sender_jid, chat_jid)
  VALUES ('delete', old.rowid, old.text, old.sender_jid, old.chat_jid);
END;

CREATE TRIGGER IF NOT EXISTS message_fts_au AFTER UPDATE ON message_cache BEGIN
  INSERT INTO message_fts(message_fts, rowid, text, sender_jid, chat_jid)
  VALUES ('delete', old.rowid, old.text, old.sender_jid, old.chat_jid);
  INSERT INTO message_fts(rowid, text, sender_jid, chat_jid)
  VALUES (new.rowid, new.text, new.sender_jid, new.chat_jid);
END;
`;

const FTS_DROP = `
DROP TRIGGER IF EXISTS message_fts_ai;
DROP TRIGGER IF EXISTS message_fts_ad;
DROP TRIGGER IF EXISTS message_fts_au;
DROP TABLE IF EXISTS message_fts;
`;

/**
 * An FTS index built with the wrong column names indexes fine and only breaks
 * when a column value is read, so a shape probe has to read one. If it fails,
 * rebuild from message_cache — the index is derived data and cheap to remake.
 * @returns {boolean} whether FTS5 is usable
 */
function ensureFts(db, logger) {
  const log = logger?.child?.({ scope: 'db' }) ?? logger;
  try {
    db.exec(FTS_SCHEMA);
    // Reading a column forces FTS5 to fetch content from message_cache.
    db.prepare('SELECT text FROM message_fts LIMIT 1').get();
    return true;
  } catch (err) {
    try {
      db.exec(FTS_DROP);
      db.exec(FTS_SCHEMA);
      db.prepare('SELECT text FROM message_fts LIMIT 1').get();
      log?.warn?.('rebuilt message_fts with a corrected shape');
      return true;
    } catch (retryErr) {
      fts = false;
      log?.warn?.(
        `FTS5 unavailable (${retryErr.message}); .search falls back to LIKE`
      );
      return false;
    }
  }
}

/** Normalise the two drivers onto one interface. */
function wrap(driver, raw) {
  const pragma = (stmt) =>
    driver === 'node:sqlite' ? raw.exec(`PRAGMA ${stmt}`) : raw.pragma(stmt);

  return {
    driver,
    raw,
    pragma,
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const s = raw.prepare(sql);
      return {
        run: (...p) => s.run(...p),
        get: (...p) => s.get(...p),
        all: (...p) => s.all(...p),
      };
    },
    close: () => raw.close(),
  };
}

async function openDriver(dbPath) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return wrap('node:sqlite', new DatabaseSync(dbPath));
  } catch (err) {
    if (err?.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && err?.code !== 'MODULE_NOT_FOUND') {
      throw err;
    }
  }
  const mod = await import('better-sqlite3');
  const Database = mod.default ?? mod;
  return wrap('better-sqlite3', new Database(dbPath));
}

/**
 * Add a column if absent. SQLite has no IF NOT EXISTS for ALTER TABLE, and a
 * duplicate raises, so probe the live shape instead.
 */
function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

function migrate(db, logger) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Seed selected-chat AI context with inbound text already captured by older
  // builds. New outgoing messages are added by MessageCache from this version.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO conversation_cache
         (id, session_jid, chat_jid, sender_jid, from_me, text, ts)
       SELECT id, session_jid, chat_jid, sender_jid, 0, text, ts
         FROM message_cache
        WHERE text IS NOT NULL AND text <> ''
          AND (chat_jid LIKE '%@s.whatsapp.net' OR chat_jid LIKE '%@lid')`
    ).run();
  } catch (err) {
    logger?.child?.({ scope: 'db' })?.warn(`conversation context migration skipped: ${err.message}`);
  }

  // Databases created before webhook failure tracking existed.
  if (addColumnIfMissing(db, 'webhooks', 'fail_count', 'INTEGER NOT NULL DEFAULT 0') ||
      addColumnIfMissing(db, 'webhooks', 'last_error', 'TEXT')) {
    logger?.child?.({ scope: 'db' })?.info('migrated webhooks table (failure tracking)');
  }

  // message_cache uses an implicit rowid; FTS5 external content needs it.
  fts = ensureFts(db, logger);
  if (fts) {
    // Fold in anything cached before the index existed (or was rebuilt).
    try {
      db.prepare("INSERT INTO message_fts(message_fts) VALUES('rebuild')").run();
    } catch (err) {
      logger?.child?.({ scope: 'db' })?.warn(`fts rebuild skipped: ${err.message}`);
    }
  }
  return fts;
}

/**
 * Open (once) and migrate the database.
 * @returns {Promise<object>} driver-agnostic handle
 */
export async function getDb(config, logger) {
  if (handle) return handle;

  fs.mkdirSync(path.dirname(config.db.path), { recursive: true });
  try {
    handle = await openDriver(config.db.path);
    handle.fts = migrate(handle, logger);
  } catch (err) {
    // A bare "disk I/O error" tells the operator nothing. The three things
    // that actually cause it here each have a different fix, so say which.
    // accessSync lies when running as root (the permission bits are bypassed),
    // so probe with a real write rather than trusting the mode bits.
    const dir = path.dirname(config.db.path);
    let writable = false;
    try {
      const probe = path.join(dir, `.nexus-write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      writable = true;
    } catch {
      writable = false;
    }
    const isDir = (() => {
      try {
        return fs.statSync(config.db.path).isDirectory();
      } catch {
        return false;
      }
    })();

    const hint = isDir
      ? `${config.db.path} is a directory, not a file — set DB_PATH to a file inside it`
      : !writable
        ? `the directory ${dir} is not writable — on Render/Koyeb/Railway the root filesystem is read-only, so mount a volume and point DB_PATH at it`
        : `another process may still hold ${config.db.path} (or its -wal/-shm files were deleted underneath it) — stop that process, or delete the stale -wal/-shm files`;
    throw new Error(`cannot open SQLite database at ${config.db.path}: ${err.message} — ${hint}`);
  }

  logger
    ?.child?.({ scope: 'db' })
    ?.info(`sqlite ready (${handle.driver}, fts5=${handle.fts}) at ${config.db.path}`);
  return handle;
}

/** Open and migrate a standalone in-memory database (tests, ephemeral runs). */
export async function getMemoryDb() {
  const db = await openDriver(':memory:');
  db.fts = migrate(db, null);
  return db;
}

export function closeDb() {
  if (handle) {
    handle.close();
    handle = null;
  }
}

// ── Settings key/value ───────────────────────────────────────────────
export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/** Boolean setting with a default — the standard on/off gate for watchers. */
export function flag(db, key, fallback = true) {
  return getSetting(db, key, fallback ? 'true' : 'false') === 'true';
}

export function setFlag(db, key, on) {
  setSetting(db, key, on ? 'true' : 'false');
}

export default { getDb, getMemoryDb, closeDb, getSetting, setSetting, flag, setFlag };
