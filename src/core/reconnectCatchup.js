import { getSetting, setSetting } from '../database/index.js';
import { captureAlertJid } from './alertRouting.js';
import { formatDateTime } from '../lib/when.js';

const OUTAGE_START_KEY = 'connection.outageStartAt';
const LAST_OPEN_KEY = 'connection.lastOpenAt';
const MAX_REPORTED_JOBS = 20;

function durationLabel(milliseconds) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} minute(s)`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hour(s) ${rest} minute(s)` : `${hours} hour(s)`;
}

/** Persist an outage window and privately report owner-actionable missed jobs. */
export class ReconnectCatchup {
  constructor({ db, scheduler, socket, config, selfJid, logger, now = () => Date.now() }) {
    this.db = db;
    this.scheduler = scheduler;
    this.socket = socket;
    this.config = config;
    this.selfJid = selfJid;
    this.logger = logger.child({ scope: 'reconnect-catchup' });
    this.now = now;
    this.timeZone = config?.scheduler?.timezone || 'Asia/Karachi';
  }

  /** If the process died without a close event, recover the last online point. */
  noteBoot(at = this.now()) {
    const lastOpen = Number(getSetting(this.db, LAST_OPEN_KEY, '0')) || 0;
    const outageStart = Number(getSetting(this.db, OUTAGE_START_KEY, '0')) || 0;
    if (!outageStart && lastOpen > 0 && at >= lastOpen) {
      setSetting(this.db, OUTAGE_START_KEY, lastOpen);
    }
  }

  onClose(_event = {}, at = this.now()) {
    const existing = Number(getSetting(this.db, OUTAGE_START_KEY, '0')) || 0;
    if (!existing) setSetting(this.db, OUTAGE_START_KEY, at);
  }

  async onOpen(_event = {}, at = this.now()) {
    const start = Number(getSetting(this.db, OUTAGE_START_KEY, '0')) || 0;
    setSetting(this.db, LAST_OPEN_KEY, at);
    if (!start || at < start) return false;

    // Any schedule already due when WhatsApp comes back requires a human
    // decision. This is stricter than the ordinary timer-jitter grace period.
    this.scheduler.markMissedDue(at, { allOverdue: true });
    const missedCount = this.scheduler.missedCount?.() ?? 0;
    const missed = this.scheduler.missed({ limit: 500 });
    setSetting(this.db, OUTAGE_START_KEY, 0);

    const destination = captureAlertJid(this.config, this.selfJid);
    if (!destination) {
      this.logger.warn('reconnected after an outage, but no private owner destination is available');
      return false;
    }

    const lines = [
      '*WhatsApp reconnected*',
      `Outage window: ${formatDateTime(start, this.timeZone)} → ${formatDateTime(at, this.timeZone)} (${durationLabel(at - start)}).`,
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
      if (missedCount > MAX_REPORTED_JOBS) {
        lines.push(`…and ${missedCount - MAX_REPORTED_JOBS} more. Use .agenda missed to review them.`);
      }
    }

    try {
      await this.socket.sendMessage(destination, { text: lines.join('\n') });
      this.logger.info(`sent reconnect catch-up to ${destination} (${missedCount} missed job(s))`);
      return { start, end: at, missed: missedCount, destination };
    } catch (error) {
      // The outage window has been recorded in the report state only after a
      // delivery succeeds; put it back so the next open/restart can retry.
      setSetting(this.db, OUTAGE_START_KEY, start);
      this.logger.error(`could not deliver reconnect catch-up: ${error.message}`);
      return false;
    }
  }
}

export default ReconnectCatchup;
