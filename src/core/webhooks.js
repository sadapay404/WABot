/**
 * Nexus-WA — outbound webhooks.
 *
 * Lets the bot act as a sensor: when something happens (a deletion, a view-once
 * capture, a keyword match) POST a JSON payload to a URL you control.
 *
 * Safety notes, because this is the one feature that sends your data somewhere
 * else:
 *   • URLs are explicit and owner-added. Nothing is sent anywhere by default.
 *   • Payloads never include media bytes — only metadata and text.
 *   • Each hook has an optional secret, sent as X-Nexus-Signature (HMAC-SHA256
 *     of the raw body) so the receiver can verify it really came from you.
 *   • Failures are logged and counted, never retried in a tight loop.
 */

import crypto from 'node:crypto';

export class Webhooks {
  /**
   * @param {object} deps
   * @param {object} deps.db
   * @param {object} deps.logger
   * @param {Function} [deps.fetchImpl] injectable for tests
   */
  constructor({ db, logger, fetchImpl = null }) {
    this.db = db;
    this.logger = logger.child({ scope: 'webhooks' });
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.stats = { sent: 0, failed: 0 };
  }

  add({ url, events = '*', secret = null }) {
    if (!/^https?:\/\//i.test(url)) throw new Error('webhook URL must be http(s)');
    const res = this.db
      .prepare('INSERT INTO webhooks(url, events, secret, enabled, created_at) VALUES (?,?,?,1,?)')
      .run(url, events, secret, Date.now());
    return this.get(Number(res.lastInsertRowid));
  }

  get(id) {
    return this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(id)) || null;
  }

  list() {
    return this.db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all();
  }

  remove(id) {
    return (this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(Number(id)).changes || 0) > 0;
  }

  setEnabled(id, on) {
    this.db.prepare('UPDATE webhooks SET enabled = ? WHERE id = ?').run(on ? 1 : 0, Number(id));
  }

  /** Which hooks care about this event? */
  #matching(event) {
    return this.list().filter((w) => {
      if (!w.enabled) return false;
      const events = String(w.events).split(',').map((e) => e.trim());
      return events.includes('*') || events.includes(event);
    });
  }

  /**
   * Fire an event. Never throws — a broken endpoint must not break the bot.
   * @param {string} event
   * @param {object} payload
   */
  async emit(event, payload = {}) {
    const hooks = this.#matching(event);
    if (!hooks.length) return 0;

    const body = JSON.stringify({ event, at: Date.now(), data: payload });
    let ok = 0;

    for (const hook of hooks) {
      const headers = { 'content-type': 'application/json', 'user-agent': 'Nexus-WA/0.3' };
      if (hook.secret) {
        headers['x-nexus-signature'] = crypto
          .createHmac('sha256', hook.secret)
          .update(body)
          .digest('hex');
      }

      try {
        const res = await this.fetch(hook.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          ok++;
          this.stats.sent++;
          // A success clears the counter, so `fail_count` means "consecutive
          // failures" — which is the number worth acting on.
          this.db
            .prepare('UPDATE webhooks SET last_status = ?, last_sent = ?, fail_count = 0, last_error = NULL WHERE id = ?')
            .run(res.status, Date.now(), hook.id);
        } else {
          this.stats.failed++;
          this.#recordFailure(hook, res.status, `HTTP ${res.status}`);
          this.logger.warn(`webhook ${hook.id} returned ${res.status}`);
        }
      } catch (err) {
        this.stats.failed++;
        this.#recordFailure(hook, 0, err.message);
        this.logger.warn(`webhook ${hook.id} failed: ${err.message}`);
      }
    }
    return ok;
  }

  #recordFailure(hook, status, message) {
    this.db
      .prepare(
        'UPDATE webhooks SET last_status = ?, last_sent = ?, fail_count = fail_count + 1, last_error = ? WHERE id = ?'
      )
      .run(status, Date.now(), String(message).slice(0, 200), hook.id);
  }
}

export default Webhooks;
