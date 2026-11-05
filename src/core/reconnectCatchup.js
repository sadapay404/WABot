import { getSetting, setSetting } from '../database/index.js';
import { captureAlertJid } from './alertRouting.js';
import { formatDateTime } from '../lib/when.js';

const OUTAGE_START_KEY = 'connection.outageStartAt';
const LAST_OPEN_KEY = 'connection.lastOpenAt';
const LAST_REPORT_KEY = 'connection.lastRecoveryReportAt';
const PENDING_MISSED_KEY = 'connection.pendingRecoveryMissedIds';
const MAX_REPORTED_JOBS = 20;

export const RECOVERY_STABLE_OPEN_MS = 60_000;
export const RECOVERY_MIN_OUTAGE_MS = 5 * 60_000;
export const RECOVERY_REPORT_COOLDOWN_MS = 30 * 60_000;

function durationLabel(milliseconds) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} minute(s)`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hour(s) ${rest} minute(s)` : `${hours} hour(s)`;
}

function readIds(db) {
  try {
    const value = JSON.parse(getSetting(db, PENDING_MISSED_KEY, '[]'));
    return new Set(Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : []);
  } catch {
    return new Set();
  }
}

/**
 * Persist outage accounting immediately, but wait for a stable connection
 * before sending one aggregated owner report. This separates missed-job safety
 * from notification delivery: flaps cannot erase a real missed-job decision.
 */
export class ReconnectCatchup {
  constructor({
    db, scheduler, socket, config, selfJid, logger, now = () => Date.now(),
    stableOpenMs = RECOVERY_STABLE_OPEN_MS,
    minOutageMs = RECOVERY_MIN_OUTAGE_MS,
    cooldownMs = RECOVERY_REPORT_COOLDOWN_MS,
  }) {
    this.db = db;
    this.scheduler = scheduler;
    this.socket = socket;
    this.config = config;
    this.selfJid = selfJid;
    this.logger = logger.child({ scope: 'reconnect-catchup' });
    this.now = now;
    this.timeZone = config?.scheduler?.timezone || 'Asia/Karachi';
    this.stableOpenMs = Math.max(0, stableOpenMs);
    this.minOutageMs = Math.max(0, minOutageMs);
    this.cooldownMs = Math.max(0, cooldownMs);
    this.recoveryTimer = null;
    this.openEpoch = 0;
    this.reportTail = Promise.resolve();
  }

  #clearTimer() {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  /** Do not present a previous process's whole healthy uptime as an outage. */
  noteBoot(at = this.now()) {
    const existing = Number(getSetting(this.db, OUTAGE_START_KEY, '0')) || 0;
    if (existing && existing > at) setSetting(this.db, OUTAGE_START_KEY, 0);
  }

  onClose(_event = {}, at = this.now()) {
    this.openEpoch++;
    this.#clearTimer();
    const existing = Number(getSetting(this.db, OUTAGE_START_KEY, '0')) || 0;
    if (!existing) setSetting(this.db, OUTAGE_START_KEY, at);
  }

  onTerminalStop() {
    this.openEpoch++;
    this.#clearTimer();
  }

  async onOpen(_event = {}, at = this.now()) {
    const start = Number(getSetting(this.db, OUTAGE_START_KEY, '0')) || 0;
    setSetting(this.db, LAST_OPEN_KEY, at);
    if (!start || at < start) return false;

    // Account for missed work immediately. Delivery of its summary is delayed
    // only until this socket proves stable.
    const before = new Set((this.scheduler.missed?.({ limit: 500 }) || []).map((job) => Number(job.id)));
    this.scheduler.markMissedDue(at, { allOverdue: true });
    const newlyMissed = (this.scheduler.missed?.({ limit: 500 }) || [])
      .filter((job) => !before.has(Number(job.id)))
      .map((job) => Number(job.id));
    if (newlyMissed.length) setSetting(this.db, PENDING_MISSED_KEY, JSON.stringify([...readIds(this.db), ...newlyMissed]));

    const epoch = ++this.openEpoch;
    this.#clearTimer();
    this.recoveryTimer = setTimeout(() => {
      if (epoch !== this.openEpoch) return;
      this.reportTail = this.reportTail
        .then(() => this.#reportStable(start, at, epoch))
        .catch((error) => this.logger.error(`reconnect catch-up: ${error.message}`));
    }, this.stableOpenMs);
    return { pending: true, start, end: at, newlyMissed: newlyMissed.length };
  }

  async #reportStable(start, end, epoch) {
    if (epoch !== this.openEpoch) return false;
    const currentStart = Number(getSetting(this.db, OUTAGE_START_KEY, '0')) || 0;
    if (currentStart !== start) return false;

    const pendingIds = readIds(this.db);
    const missed = (this.scheduler.missed?.({ limit: 500 }) || [])
      .filter((job) => pendingIds.has(Number(job.id)));
    const missedCount = missed.length;
    const duration = Math.max(0, end - start);
    const lastReport = Number(getSetting(this.db, LAST_REPORT_KEY, '0')) || 0;
    const meaningful = duration >= this.minOutageMs;
    const coolingDown = lastReport > 0 && end - lastReport < this.cooldownMs;

    // A non-actionable flap is closed silently. Cooldown aggregates ordinary
    // reports, but never hides newly missed work that needs an owner decision.
    if (!missedCount && (!meaningful || coolingDown)) {
      setSetting(this.db, OUTAGE_START_KEY, 0);
      return false;
    }

    const destination = captureAlertJid(this.config, this.selfJid);
    if (!destination) {
      this.logger.warn('stable recovery report pending: no private owner destination is available');
      return false;
    }

    const lines = [
      '*WhatsApp reconnected*',
      `Outage window: ${formatDateTime(start, this.timeZone)} → ${formatDateTime(end, this.timeZone)} (${durationLabel(duration)}).`,
      missedCount
        ? `Schedules needing your decision: ${missedCount}. Nothing missed was sent late automatically.`
        : 'No missed schedule is waiting for an owner decision.',
    ];
    if (missed.length) {
      lines.push('');
      for (const job of missed.slice(0, MAX_REPORTED_JOBS)) {
        lines.push(`#${job.id} · ${formatDateTime(job.run_at, this.timeZone)} · ${String(job.text || '').slice(0, 120)}`);
        lines.push(`   Send now: .agenda missed send ${job.id} · Skip: .agenda missed skip ${job.id}`);
      }
      if (missedCount > MAX_REPORTED_JOBS) lines.push(`…and ${missedCount - MAX_REPORTED_JOBS} more. Use .agenda missed to review them.`);
    }

    try {
      await this.socket.sendMessage(destination, { text: lines.join('\n') }, { nexusSystemEvent: true });
      // A newer close must never be overwritten by completion of this older report.
      if ((Number(getSetting(this.db, OUTAGE_START_KEY, '0')) || 0) !== start || epoch !== this.openEpoch) return false;
      setSetting(this.db, OUTAGE_START_KEY, 0);
      setSetting(this.db, LAST_REPORT_KEY, end);
      setSetting(this.db, PENDING_MISSED_KEY, JSON.stringify([]));
      this.logger.info(`sent stable reconnect catch-up (${missedCount} newly missed job(s))`);
      return { start, end, missed: missedCount, destination };
    } catch (error) {
      // Keep the exact outage/report state for a later stable open. Do not
      // restore an older start over a newer flap.
      this.logger.error(`could not deliver reconnect catch-up: ${error.message}`);
      return false;
    }
  }

  stop() {
    this.onTerminalStop();
  }
}

export default ReconnectCatchup;
