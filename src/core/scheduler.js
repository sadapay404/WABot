/**
 * Nexus-WA — persistent scheduler.
 *
 * Jobs live in SQLite, not in memory, so a restart on an ephemeral PaaS box
 * does not lose a reminder you set three days ago.
 *
 * Crash safety:
 *   A job is marked 'running' the moment it is picked up. On boot, anything
 *   still 'running' is reset to 'pending' — that can only mean the process
 *   died mid-delivery, and re-sending is the lesser evil compared to a
 *   reminder that silently vanishes.
 *
 * Delivery goes through `socket.sendMessage`, which the OutboundQueue has
 * already wrapped. Scheduled blasts therefore inherit the same rate limits as
 * interactive replies; there is no fast path around the safety layer.
 */

import { flag, setFlag } from '../database/index.js';
import { normalizeJid } from './jid.js';
import { nextCalendarOccurrence } from '../lib/when.js';

export class Scheduler {
  /**
   * @param {object} deps
   * @param {object} deps.db
   * @param {object} deps.socket
   * @param {object} deps.logger
   * @param {object} deps.contacts
   * @param {number} [deps.tickMs]    poll interval, default 15s
   * @param {Function} [deps.onFire]  hook for webhooks/audit
   */
  constructor({ db, socket, logger, contacts = null, tickMs = 15_000, maxPerTick = 25, onFire = null }) {
    this.db = db;
    this.socket = socket;
    this.logger = logger.child({ scope: 'scheduler' });
    this.contacts = contacts;
    this.tickMs = tickMs;
    /** Cap per tick, so a backlog after downtime cannot burst-spam a chat. */
    this.maxPerTick = Math.max(1, maxPerTick);
    this.onFire = onFire;
    this.timer = null;
    this.stats = { fired: 0, failed: 0, rearmed: 0, resumed: 0 };
    /** Injectable clock, so tests do not have to sleep. */
    this.now = () => Date.now();
  }

  enabled() {
    return flag(this.db, 'scheduler.enabled', true);
  }
  setEnabled(on) {
    setFlag(this.db, 'scheduler.enabled', on);
    return this.enabled();
  }

  /** Reset anything the previous process was mid-way through. */
  resumeOrphans() {
    const res = this.db
      .prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'")
      .run();
    this.stats.resumed = res.changes || 0;
    if (this.stats.resumed) {
      this.logger.warn(`resumed ${this.stats.resumed} interrupted job(s) after restart`);
    }
    return this.stats.resumed;
  }

  /**
   * @param {object} job
   * @param {string} job.jid        destination
   * @param {string} job.text       message body
   * @param {number} job.runAt      epoch ms
   * @param {string} [job.kind]     'once' | 'recurring'
   * @param {number} [job.intervalMs] for recurring
   */
  add({ jid, text, runAt, kind = 'once', intervalMs = null, recurrence = null }) {
    if (!jid) throw new Error('a job needs a destination JID');
    if (!Number.isFinite(runAt)) throw new Error('a job needs a numeric runAt');
    if (recurrence?.needsDatePolicy) {
      throw new Error('the recurring date rule needs a missing-date policy');
    }

    const storedKind = recurrence
      ? 'calendar'
      : kind === 'recurring'
        ? `every:${intervalMs}`
        : 'once';
    const rule = recurrence ? JSON.stringify(recurrence) : intervalMs ? String(intervalMs) : null;
    const res = this.db
      .prepare(
        `INSERT INTO jobs(kind, jid, text, run_at, cron, status, created_at)
         VALUES (?,?,?,?,?, 'pending', ?)`
      )
      .run(
        storedKind,
        normalizeJid(jid),
        text,
        Math.floor(runAt),
        rule,
        this.now()
      );
    const id = Number(res.lastInsertRowid);
    this.logger.info(`job ${id} scheduled for ${new Date(runAt).toISOString()}`);
    return this.get(id);
  }

  get(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id)) || null;
  }

  list({ status = null, limit = 50 } = {}) {
    return status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY run_at LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM jobs ORDER BY run_at LIMIT ?').all(limit);
  }

  pending() {
    return this.list({ status: 'pending' });
  }

  /** Pending sends whose next run is before `end`, including overdue jobs. */
  agenda({ end, limit = 200 } = {}) {
    if (!Number.isFinite(end)) throw new Error('agenda needs a numeric end time');
    return this.db
      .prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_at < ? ORDER BY run_at LIMIT ?")
      .all(end, Math.max(1, Math.min(Number(limit) || 200, 1_000)));
  }

  cancel(id) {
    const res = this.db
      .prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .run(Number(id));
    return (res.changes || 0) > 0;
  }

  start() {
    if (this.timer) return this;
    this.resumeOrphans();
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error(`tick failed: ${err.message}`));
    }, this.tickMs);
    // Never hold the process open just for the ticker.
    this.timer.unref?.();
    this.logger.info(`scheduler ticking every ${Math.round(this.tickMs / 1000)}s`);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Fire everything that is due. Returns the jobs handled.
   * @param {number} [now]
   */
  async tick(now = this.now()) {
    if (!this.enabled()) return [];

    const due = this.db
      .prepare('SELECT * FROM jobs WHERE status = ? AND run_at <= ? ORDER BY run_at LIMIT ?')
      .all('pending', now, this.maxPerTick);

    const done = [];
    for (const job of due) {
      this.db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(job.id);
      try {
        await this.#deliver(job);
        this.#finish(job, now);
        this.stats.fired++;
        this.onFire?.(job);
      } catch (err) {
        this.stats.failed++;
        this.logger.error(`job ${job.id} failed: ${err.message}`);
        // Keep it pending so it retries on the next tick, but record why.
        this.db
          .prepare("UPDATE jobs SET status = 'pending', last_error = ? WHERE id = ?")
          .run(String(err.message).slice(0, 400), job.id);
      }
      done.push(job.id);
    }
    return done;
  }

  async #deliver(job) {
    if (!this.socket) throw new Error('no transport attached');
    // Deliver the confirmed message body verbatim. Schedule metadata belongs in
    // the owner-side preview, not as an unsolicited prefix sent to recipients.
    await this.socket.sendMessage(job.jid, { text: String(job.text ?? '') });
  }

  #finish(job, now) {
    if (job.kind === 'calendar') {
      let recurrence;
      try {
        recurrence = JSON.parse(job.cron || 'null');
      } catch {
        recurrence = null;
      }
      let next = recurrence ? nextCalendarOccurrence(job.run_at, recurrence) : null;
      let skipped = 0;
      while (next !== null && next <= now && skipped < 10_000) {
        next = nextCalendarOccurrence(next, recurrence);
        skipped++;
      }
      if (next !== null && next > now) {
        this.db
          .prepare("UPDATE jobs SET status = 'pending', run_at = ?, fired_at = ?, last_error = NULL WHERE id = ?")
          .run(next, now, job.id);
        this.stats.rearmed++;
        return;
      }
      // A malformed/unsupported rule is retired rather than being retried after
      // a successful send, which could otherwise duplicate the message.
      this.logger.error(`calendar job ${job.id} could not be re-armed; marking it done`);
      this.db
        .prepare("UPDATE jobs SET status = 'done', fired_at = ?, last_error = ? WHERE id = ?")
        .run(now, 'Recurring rule could not be advanced', job.id);
      return;
    }

    if (job.kind.startsWith('every:')) {
      const interval = Number.parseInt(job.kind.split(':')[1], 10);
      if (Number.isFinite(interval) && interval > 0) {
        // Re-arm from the scheduled time, not from "now", so a delayed tick
        // does not drift the schedule further each cycle.
        let next = job.run_at + interval;
        while (next <= now) next += interval;
        this.db
          .prepare("UPDATE jobs SET status = 'pending', run_at = ?, fired_at = ?, last_error = NULL WHERE id = ?")
          .run(next, now, job.id);
        this.stats.rearmed++;
        return;
      }
    }
    this.db
      .prepare("UPDATE jobs SET status = 'done', fired_at = ?, last_error = NULL WHERE id = ?")
      .run(now, job.id);
  }

  summary() {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status='done'      THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
           COUNT(*) AS total
         FROM jobs`
      )
      .get();
    return {
      pending: row.pending || 0,
      done: row.done || 0,
      cancelled: row.cancelled || 0,
      total: row.total || 0,
      ...this.stats,
    };
  }
}

export default Scheduler;
