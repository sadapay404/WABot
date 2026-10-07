/**
 * Nexus-WA — remote vault.
 *
 * Free PaaS tiers have an ephemeral filesystem: Render's free web services
 * cannot attach a persistent disk at all, so `data/auth` and the SQLite file
 * are deleted on every restart, redeploy or idle spin-down. That would mean
 * re-pairing WhatsApp constantly — which is itself a signal Meta looks at.
 *
 * This bridges that gap using the encrypted `.nwb` format SessionBackup
 * already produces:
 *
 *   boot  → if data/auth is empty and a remote backup exists, pull and restore
 *   every N minutes, and on clean shutdown → create a fresh backup and push it
 *
 * The blob is AES-256-GCM encrypted with a passphrase before it leaves the
 * process, so the remote store never sees your session keys — only ciphertext
 * it cannot decrypt. That matters because on this path the "remote store" is
 * something like a GitHub repo, i.e. a third party.
 *
 * Two backends, both speaking plain HTTPS:
 *   github — the Contents API, using a fine-grained PAT scoped to one repo
 *   http   — a generic PUT/GET with a bearer token (WebDAV, S3-compatible,
 *            or any endpoint that accepts a body and returns it verbatim)
 */

const GITHUB_API = 'https://api.github.com';

export class RemoteVault {
  /**
   * @param {object} deps
   * @param {object} deps.logger
   * @param {object} deps.backup   SessionBackup instance
   * @param {object} deps.cfg      { kind, url, token, passphrase, path, intervalMin }
   * @param {Function} [deps.fetchImpl]
   */
  constructor({ logger, backup, cfg, fetchImpl = null }) {
    this.logger = logger.child({ scope: 'vault' });
    this.backup = backup;
    this.cfg = cfg;
    this.fetch = fetchImpl || globalThis.fetch;
    this.timer = null;
    this.stats = { pushed: 0, pulled: 0, failed: 0, restored: 0, skipped: 0 };
  }

  /** True only when everything needed to talk to a remote is present. */
  enabled() {
    const c = this.cfg || {};
    return Boolean(c.url && c.token && c.passphrase);
  }

  /** Why it is not usable, for logs and `.status`. */
  reasonDisabled() {
    const missing = [];
    if (!this.cfg?.url) missing.push('REMOTE_VAULT_URL');
    if (!this.cfg?.token) missing.push('REMOTE_VAULT_TOKEN');
    if (!this.cfg?.passphrase) missing.push('REMOTE_VAULT_PASSPHRASE');
    return missing.length ? `not configured (missing ${missing.join(', ')})` : 'ready';
  }

  /**
   * Push a fresh encrypted backup to the remote.
   * @returns {Promise<boolean>}
   */
  async push() {
    if (!this.enabled()) {
      this.stats.skipped++;
      return false;
    }
    let file = null;
    try {
      const made = this.backup.create(this.cfg.passphrase);
      file = made.file;
      const blob = this.backup.readFile(file);
      await this.#upload(blob);
      this.stats.pushed++;
      this.logger.info(`pushed ${made.bytes}B backup to the remote vault`);
      return true;
    } catch (err) {
      this.stats.failed++;
      // Never throw out of a timer callback: a failed upload must not take the
      // bot down. The session is still on the local disk.
      this.logger.error(`vault push failed: ${err.message}`);
      return false;
    } finally {
      if (file) this.backup.discard(file);
    }
  }

  /**
   * Download the remote backup, if any.
   * @returns {Promise<Buffer|null>}
   */
  async pull() {
    if (!this.enabled()) {
      this.stats.skipped++;
      return null;
    }
    try {
      const blob = await this.#download();
      if (!blob?.length) return null;
      this.stats.pulled++;
      return blob;
    } catch (err) {
      // A 404 on first ever boot is normal, not an error.
      if (/404|not found/i.test(err.message)) {
        this.logger.info('no remote backup yet — this is normal on a first boot');
        return null;
      }
      this.stats.failed++;
      this.logger.warn(`vault pull failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Restore from the remote vault, but only if there is nothing local to lose.
   *
   * The guard is the important part: silently overwriting a live session with
   * an older remote copy would unlink the device that is currently working.
   *
   * @param {boolean} localSessionExists
   * @returns {Promise<boolean>} whether a restore happened
   */
  async restoreIfEmpty(localSessionExists) {
    if (!this.enabled()) {
      this.stats.skipped++;
      return false;
    }
    if (localSessionExists) {
      this.logger.info('local session present — not touching it');
      return false;
    }
    const blob = await this.pull();
    if (!blob) return false;
    try {
      const res = this.backup.restoreBuffer(blob, this.cfg.passphrase);
      this.stats.restored++;
      this.logger.warn(
        `restored session from the remote vault (${res.sessions} credential file(s)) — ` +
          'WhatsApp may ask you to confirm this device'
      );
      return true;
    } catch (err) {
      this.stats.failed++;
      // Deliberately does not distinguish a wrong passphrase from a corrupt
      // blob: neither should be guessable from the log.
      this.logger.error(
        'remote backup could not be decrypted — it is either corrupt or ' +
          'REMOTE_VAULT_PASSPHRASE does not match the one used to create it. ' +
          'You will need to pair again.'
      );
      return false;
    }
  }

  /** Start the periodic push. Returns the interval used, or 0 if disabled. */
  start() {
    if (!this.enabled() || this.timer) return 0;
    const min = Math.max(5, Number(this.cfg.intervalMin) || 30);
    this.timer = setInterval(() => {
      this.push().catch((err) => this.logger.error(`scheduled push: ${err.message}`));
    }, min * 60_000);
    this.timer.unref?.();
    this.logger.info(`pushing an encrypted backup to the remote vault every ${min}m`);
    return min;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── backends ──────────────────────────────────────────────────────
  async #upload(blob) {
    if (this.cfg.kind === 'github') return this.#githubPut(blob);
    return this.#httpPut(blob);
  }

  async #download() {
    if (this.cfg.kind === 'github') return this.#githubGet();
    return this.#httpGet();
  }

  /** "owner/repo" and an optional path, parsed out of the configured URL. */
  #githubParts() {
    const m = String(this.cfg.url).match(
      /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?(?:\/(.*))?$/
    );
    if (!m) throw new Error(`REMOTE_VAULT_URL does not look like a GitHub repo: ${this.cfg.url}`);
    return { owner: m[1], repo: m[2], path: this.cfg.path || 'nexus-backup.nwb' };
  }

  async #githubGet() {
    const { owner, repo, path } = this.#githubParts();
    const res = await this.fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
      {
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      }
    );
    if (res.status === 404) throw new Error('404 not found');
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const json = await res.json();
    // The Contents API returns base64 with newlines folded in.
    return Buffer.from(String(json.content || '').replace(/\s/g, ''), 'base64');
  }

  async #githubPut(blob) {
    const { owner, repo, path } = this.#githubParts();
    const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
    const headers = {
      authorization: `Bearer ${this.cfg.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    };

    // Updating an existing file needs its current sha, or GitHub rejects it.
    let sha;
    try {
      const cur = await this.fetch(url, { headers });
      if (cur.ok) sha = (await cur.json()).sha;
    } catch {
      /* first upload — nothing to update */
    }

    const res = await this.fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `nexus-wa: encrypted session backup ${new Date().toISOString()}`,
        content: blob.toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`GitHub rejected the upload (${res.status})`);
  }

  async #httpGet() {
    const res = await this.fetch(this.cfg.url, {
      headers: { authorization: `Bearer ${this.cfg.token}` },
    });
    if (res.status === 404) throw new Error('404 not found');
    if (!res.ok) throw new Error(`remote responded ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async #httpPut(blob) {
    const res = await this.fetch(this.cfg.url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        'content-type': 'application/octet-stream',
      },
      body: blob,
    });
    if (!res.ok) throw new Error(`remote rejected the upload (${res.status})`);
  }
}

export default RemoteVault;
