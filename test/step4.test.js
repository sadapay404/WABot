/**
 * Nexus-WA — Step 4 tests: the remote vault that keeps a WhatsApp session
 * alive on hosts with an ephemeral filesystem.
 *
 * Everything runs against an in-memory fake HTTP endpoint, so these exercise
 * the real encrypt/upload/decrypt/restore path without touching the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../src/core/logger.js';
import { SessionBackup } from '../src/core/backup.js';
import { RemoteVault } from '../src/core/remoteVault.js';

const quiet = createLogger('fatal');
const PASS = 'correct horse battery';

/** A rig: real SessionBackup against a temp dir, plus a fake remote store. */
function rig({ kind = 'http', fetchImpl = null, extra = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nwb-vault-'));
  const sessionDir = path.join(tmp, 'auth');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'creds.json'), '{"noiseKey":"TOP-SECRET-KEY"}');
  const dbPath = path.join(tmp, 'nexus.db');
  fs.writeFileSync(dbPath, 'database-bytes');

  const backup = new SessionBackup({
    logger: quiet, sessionDir, dbPath, dir: path.join(tmp, 'backups'),
  });

  // In-memory "remote". A Map keyed by request URL.
  const store = new Map();
  const calls = [];
  const fakeFetch = fetchImpl || (async (url, init = {}) => {
    calls.push({ url, init });
    const method = init.method || 'GET';
    if (method === 'PUT') {
      let body = init.body;
      // The GitHub backend sends JSON with base64 content; http sends raw bytes.
      if (typeof body === 'string') {
        body = Buffer.from(JSON.parse(body).content, 'base64');
      }
      store.set(String(url), body);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (!store.has(String(url))) return { ok: false, status: 404, json: async () => ({}) };
    const blob = store.get(String(url));
    return {
      ok: true, status: 200,
      arrayBuffer: async () => blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
      // GitHub's Contents API returns base64 JSON, not raw bytes.
      json: async () => ({ content: blob.toString('base64'), sha: 'abc123' }),
    };
  });

  const vault = new RemoteVault({
    logger: quiet, backup,
    cfg: {
      kind,
      url: kind === 'github' ? 'https://github.com/me/nexus-vault' : 'https://vault.test/blob',
      token: 'tok', passphrase: PASS, path: 'nexus-backup.nwb', intervalMin: 30,
      ...extra,
    },
    fetchImpl: fakeFetch,
  });

  return { tmp, sessionDir, dbPath, backup, vault, store, calls };
}

// ── configuration ────────────────────────────────────────────────────
test('vault: disabled until every required value is present, and says which', () => {
  const v = new RemoteVault({
    logger: quiet, backup: null,
    cfg: { url: 'https://x', token: '', passphrase: '' },
  });
  assert.equal(v.enabled(), false);
  assert.match(v.reasonDisabled(), /REMOTE_VAULT_TOKEN/);
  assert.match(v.reasonDisabled(), /REMOTE_VAULT_PASSPHRASE/);
  assert.doesNotMatch(v.reasonDisabled(), /REMOTE_VAULT_URL/);
});

test('vault: push and pull are inert no-ops when not configured', async () => {
  const v = new RemoteVault({ logger: quiet, backup: null, cfg: {} });
  assert.equal(await v.push(), false);
  assert.equal(await v.pull(), null);
  assert.equal(await v.restoreIfEmpty(false), false);
  assert.equal(v.stats.skipped, 3, 'each call must record why it did nothing');
});

// ── the security property ────────────────────────────────────────────
test('vault: the blob that leaves the process cannot leak the session keys', async () => {
  const { vault, store } = rig();
  assert.equal(await vault.push(), true);

  const remote = store.get('https://vault.test/blob');
  assert.ok(remote, 'something was uploaded');
  assert.equal(remote.subarray(0, 6).toString(), 'NEXWA1', 'is a Nexus backup blob');
  assert.ok(
    !remote.includes(Buffer.from('TOP-SECRET-KEY')),
    'the session private key must not appear in the uploaded bytes'
  );
  assert.ok(
    !remote.includes(Buffer.from('database-bytes')),
    'the database must not appear in the uploaded bytes either'
  );
});

test('vault: the local blob is discarded after a successful push', async () => {
  const { vault, backup } = rig();
  const before = backup.list().length;
  await vault.push();
  assert.equal(backup.list().length, before, 'no extra backup left on the ephemeral disk');
});

// ── the round-trip that makes free hosting viable ────────────────────
test('vault: a wiped session directory is restored from the remote', async () => {
  const { sessionDir, dbPath, vault } = rig();
  await vault.push();

  // Simulate the ephemeral filesystem being wiped on restart.
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(dbPath, '');
  assert.equal(fs.readdirSync(sessionDir).length, 0);

  const restored = await vault.restoreIfEmpty(false);
  assert.equal(restored, true, 'restore should have happened');
  assert.equal(
    fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8'),
    '{"noiseKey":"TOP-SECRET-KEY"}',
    'credentials came back intact'
  );
  assert.equal(fs.readFileSync(dbPath, 'utf8'), 'database-bytes');
  assert.equal(vault.stats.restored, 1);
});

// ── the safety guard ─────────────────────────────────────────────────
test('vault: an existing local session is never overwritten by an older remote copy', async () => {
  const { sessionDir, vault } = rig();
  await vault.push();

  // The device has since re-paired; the local copy is now the authoritative one.
  fs.writeFileSync(path.join(sessionDir, 'creds.json'), '{"noiseKey":"NEWER-LOCAL-SESSION"}');

  const restored = await vault.restoreIfEmpty(true);
  assert.equal(restored, false, 'must refuse to restore over a live session');
  assert.equal(
    fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8'),
    '{"noiseKey":"NEWER-LOCAL-SESSION"}',
    'the working session must be untouched'
  );
  assert.equal(vault.stats.restored, 0);
});

// ── failure modes ────────────────────────────────────────────────────
test('vault: a missing remote backup on first boot is not an error', async () => {
  const { vault } = rig();
  assert.equal(await vault.pull(), null);
  assert.equal(vault.stats.failed, 0, 'a 404 must not count as a failure');
  assert.equal(await vault.restoreIfEmpty(false), false);
});

test('vault: a wrong passphrase fails cleanly and does not crash the bot', async () => {
  const { sessionDir, vault } = rig();
  await vault.push();
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  vault.cfg.passphrase = 'a different passphrase';
  const restored = await vault.restoreIfEmpty(false);
  assert.equal(restored, false);
  assert.equal(vault.stats.failed, 1);
  assert.equal(fs.readdirSync(sessionDir).length, 0, 'nothing half-restored');
});

test('vault: a failing upload never throws out of the timer', async () => {
  const boom = async () => {
    throw new Error('ECONNREFUSED');
  };
  const { vault } = rig({ fetchImpl: boom });
  const res = await vault.push();
  assert.equal(res, false);
  assert.equal(vault.stats.failed, 1);
});

test('vault: a non-2xx upload response is a failure, not a silent success', async () => {
  const { vault } = rig({
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  assert.equal(await vault.push(), false);
  assert.equal(vault.stats.failed, 1);
  assert.equal(vault.stats.pushed, 0);
});

// ── GitHub backend specifics ─────────────────────────────────────────
test('vault: the GitHub backend sends the existing sha so an update is accepted', async () => {
  const { vault, store, calls } = rig({ kind: 'github' });

  await vault.push();
  assert.equal(vault.stats.pushed, 1);

  const puts = calls.filter((c) => c.init.method === 'PUT');
  assert.ok(puts.length >= 1, 'a PUT was issued');
  const body = JSON.parse(puts[0].init.body);
  assert.ok(body.content, 'content is base64 in the GitHub payload');
  assert.match(body.message, /encrypted session backup/);
  assert.ok(
    calls.some((c) => c.init.headers?.authorization === 'Bearer tok'),
    'the token is sent as a bearer header'
  );
  assert.ok(store.size >= 1, 'the blob reached the store');
});

test('vault: a malformed GitHub URL is reported, not silently mis-parsed', async () => {
  const { vault } = rig({ kind: 'github', extra: { url: 'https://example.com/not-github' } });
  assert.equal(await vault.push(), false);
  assert.equal(vault.stats.failed, 1);
});

// ── scheduling ───────────────────────────────────────────────────────
test('vault: start() refuses intervals short enough to hammer the remote', () => {
  const { vault } = rig({ extra: { intervalMin: 1 } });
  const used = vault.start();
  assert.equal(used, 5, 'clamped to the 5-minute floor');
  vault.stop();
  assert.equal(vault.timer, null, 'stop() clears the timer');
});

test('vault: start() returns 0 and does nothing when not configured', () => {
  const v = new RemoteVault({ logger: quiet, backup: null, cfg: {} });
  assert.equal(v.start(), 0);
  assert.equal(v.timer, null);
});
