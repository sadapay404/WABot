import { normalizeJid } from './jid.js';

const DEFAULT_LOOP_THRESHOLD = 5;
const MAX_LOOP_THRESHOLD = 25;
const DEFAULT_LOOP_WINDOW_MS = 60_000;
const MAX_LOOP_WINDOW_MS = 3_600_000;
const DEFAULT_VOLUME_LIMIT = 30;
const MAX_VOLUME_LIMIT = 1_000;
const DEFAULT_VOLUME_WINDOW_MS = 60_000;
const MAX_VOLUME_WINDOW_MS = 3_600_000;
const LOOP_HISTORY_MAX_DESTINATIONS = 500;
const LOOP_MIN_TOKENS_FOR_FUZZY_MATCH = 3;
const LOOP_TOKEN_OVERLAP_THRESHOLD = 0.8;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? Math.trunc(number) : fallback));
}

function outboundText(content) {
  if (typeof content === 'string') return normalizeLoopText(content.slice(0, 2_000));
  if (!content || typeof content !== 'object') return '';
  const text = [content.text, content.caption]
    .filter((part) => typeof part === 'string')
    .join(' ')
    .slice(0, 2_000);
  return normalizeLoopText(text);
}

function normalizeLoopText(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, ' ')
    .trim();
}

/** Exact normalized match, or at least 80% token overlap for texts with 3+ tokens. */
function similarLoopText(left, right) {
  if (left === right) return true;
  const a = new Set(left.split(' ').filter(Boolean));
  const b = new Set(right.split(' ').filter(Boolean));
  if (Math.min(a.size, b.size) < LOOP_MIN_TOKENS_FOR_FUZZY_MATCH) return false;
  let common = 0;
  for (const token of a) if (b.has(token)) common++;
  return common / Math.min(a.size, b.size) >= LOOP_TOKEN_OVERLAP_THRESHOLD;
}

/**
 * Nexus-WA — outbound queue.
 *
 * Normal messages, including scheduled ones, go through this queue so plugins
 * cannot bypass pacing. Five things it adds beyond the raw socket are:
 *
 *   1. serialises sends (concurrency 1) — bursts are the loudest signal an
 *      unofficial client can emit
 *   2. enforces a per-chat per-minute budget
 *   3. shows a typing/composing presence and waits a beat proportional to the
 *      message length, so replies look like they were typed by a person
 *   4. trips a loop breaker before the Nth similar text/caption reaches the
 *      same destination within its safety window
 *   5. alerts the owner on a global outbound-volume spike (without halting)
 *
 * It wraps the socket, so callers keep using `sock.sendMessage(...)` and the
 * protection is structural rather than a convention someone can forget.
 */

export class OutboundQueue {
  /**
   * @param {object} socket  raw Baileys socket (or the mock)
   * @param {object} config
   * @param {object} logger
   */
  constructor(socket, config, logger) {
    this.socket = socket;
    this.config = config;
    this.logger = logger.child({ scope: 'outbound' });

    this.limitPerMin = config.safety.rateLimitPerMin;
    this.windowMs = Math.max(50, config.safety.rateLimitWindowMs || 60000);
    this.concurrency = Math.max(1, config.safety.queueConcurrency);
    this.typing = config.safety.typingIndicator;
    this.loopThreshold = boundedInteger(
      config.safety.outboundLoopThreshold,
      DEFAULT_LOOP_THRESHOLD,
      2,
      MAX_LOOP_THRESHOLD
    );
    this.loopWindowMs = boundedInteger(
      config.safety.outboundLoopWindowMs,
      DEFAULT_LOOP_WINDOW_MS,
      1_000,
      MAX_LOOP_WINDOW_MS
    );
    this.volumeLimit = boundedInteger(
      config.safety.outboundVolumeLimit,
      DEFAULT_VOLUME_LIMIT,
      5,
      MAX_VOLUME_LIMIT
    );
    this.volumeWindowMs = boundedInteger(
      config.safety.outboundVolumeWindowMs,
      DEFAULT_VOLUME_WINDOW_MS,
      1_000,
      MAX_VOLUME_WINDOW_MS
    );

    /** Kill-switch state. When true nothing leaves the process. */
    this.halted = false;
    this.haltReason = 'kill-switch';
    /** One-shot passes through the kill-switch (see allowOnce). */
    this.escape = 0;

    /** @type {Map<string, number[]>} jid -> send timestamps */
    this.windows = new Map();
    /** Recent normalized text per destination; size-bounded and lazily expired. */
    this.loopHistory = new Map();
    /** Successful outbound send timestamps, capped at the anomaly threshold. */
    this.volumeWindow = [];
    this.lastVolumeAlertAt = 0;
    this.rawSendMessage = null;
    this.beforeSendObservers = new Set();
    this.queue = [];
    this.active = 0;
    this.stats = {
      sent: 0,
      throttledMs: 0,
      dropped: 0,
      typing: 0,
      loopBreakerTrips: 0,
      volumeAnomalyAlerts: 0,
    };
    this.logger.info(
      `outbound loop breaker active (${this.loopThreshold} similar messages / ${Math.round(this.loopWindowMs / 1000)}s)`
    );
    this.logger.info(
      `outbound volume alert active (${this.volumeLimit} sends / ${Math.round(this.volumeWindowMs / 1000)}s)`
    );
  }

  /** Observe sends immediately before transport, for echo suppression/auditing. */
  onBeforeSend(callback) {
    if (typeof callback !== 'function') throw new TypeError('send observer must be a function');
    this.beforeSendObservers.add(callback);
    return () => this.beforeSendObservers.delete(callback);
  }

  #notifyBeforeSend(jid, content) {
    for (const observer of this.beforeSendObservers) {
      try {
        observer(jid, content);
      } catch (error) {
        this.logger.warn(`outbound observer failed: ${error.message}`);
      }
    }
  }

  /** Wrap a socket with outbound pacing and loop protection. */
  attach() {
    const original = this.socket.sendMessage.bind(this.socket);
    this.rawSendMessage = original;
    const self = this;

    this.socket.sendMessage = function queuedSendMessage(jid, content, options) {
      return self.#enqueue(() => original(jid, content, options), jid, content);
    };

    this.socket.__outboundQueue = this;
    return this.socket;
  }

  #withinBudget(jid) {
    const now = Date.now();
    const win = (this.windows.get(jid) || []).filter((t) => now - t < this.windowMs);
    this.windows.set(jid, win);
    return win.length < this.limitPerMin;
  }

  #enqueue(task, jid, content) {
    return new Promise((resolve, reject) => {
      let bypassSafetyMonitors = false;
      if (this.halted) {
        // A single explicit pass lets `.panic` confirm its halt and lets the
        // loop breaker deliver its owner alert without reopening general sends.
        if (this.escape > 0) {
          this.escape--;
          bypassSafetyMonitors = true;
        } else {
          this.stats.dropped++;
          return reject(new Error(`outbound halted by ${this.haltReason}`));
        }
      }
      this.queue.push({ task, jid, content, bypassSafetyMonitors, resolve, reject });
      this.#pump();
    });
  }

  /**
   * Panic stop. Drops everything queued and refuses new sends until resume().
   * @returns {number} how many queued messages were discarded
   */
  halt(reason = 'kill-switch') {
    this.halted = true;
    this.haltReason = reason;
    const dropped = this.queue.length;
    const pending = this.queue.splice(0, this.queue.length);
    for (const item of pending) {
      this.stats.dropped++;
      item.reject(new Error(`outbound halted by ${reason}`));
    }
    this.logger.warn(`${reason.toUpperCase().replaceAll('-', ' ')} engaged — dropped ${dropped} queued message(s)`);
    return dropped;
  }

  /**
   * Let exactly one further send through the kill-switch for an owner
   * confirmation/alert. Deliberately a single message — not a bypass for bulk
   * sends.
   */
  allowOnce() {
    this.escape++;
  }

  resume() {
    this.halted = false;
    this.haltReason = 'kill-switch';
    this.escape = 0;
    this.logger.info('kill-switch released — outbound resumed');
  }

  #checkLoop(item) {
    const text = outboundText(item.content).slice(0, 1_000);
    const destination = normalizeJid(item.jid);
    if (!text || !destination) return null;

    const now = Date.now();
    const recent = (this.loopHistory.get(destination) || [])
      .filter((entry) => now - entry.at <= this.loopWindowMs);
    const matching = recent.filter((entry) => similarLoopText(text, entry.text)).length;

    if (matching >= this.loopThreshold - 1) {
      this.loopHistory.set(destination, recent);
      return { destination, count: matching + 1 };
    }

    if (!this.loopHistory.has(destination) && this.loopHistory.size >= LOOP_HISTORY_MAX_DESTINATIONS) {
      this.loopHistory.delete(this.loopHistory.keys().next().value);
    }
    recent.push({ text, at: now });
    // Keep enough history for non-consecutive repeats without allowing an
    // unusually chatty destination to grow memory without bound.
    const maxPerDestination = Math.max(20, this.loopThreshold * 2);
    if (recent.length > maxPerDestination) recent.splice(0, recent.length - maxPerDestination);
    this.loopHistory.delete(destination);
    this.loopHistory.set(destination, recent);
    return null;
  }

  #checkVolumeAnomaly() {
    const now = Date.now();
    this.volumeWindow = this.volumeWindow.filter((sentAt) => now - sentAt <= this.volumeWindowMs);
    this.volumeWindow.push(now);
    if (this.volumeWindow.length > this.volumeLimit) {
      this.volumeWindow.splice(0, this.volumeWindow.length - this.volumeLimit);
    }

    if (this.volumeWindow.length < this.volumeLimit || now - this.lastVolumeAlertAt < this.volumeWindowMs) {
      return null;
    }

    this.lastVolumeAlertAt = now;
    this.stats.volumeAnomalyAlerts++;
    return { count: this.volumeWindow.length };
  }

  async #alertVolumeAnomaly({ count }) {
    const seconds = Math.ceil(this.volumeWindowMs / 1_000);
    this.logger.warn(
      `outbound volume warning: ${count} successful sends within ${this.volumeWindowMs}ms`
    );

    const ownerJid =
      normalizeJid(this.socket?.user?.id) || normalizeJid(this.config?.safety?.ownerJids?.[0]);
    if (!ownerJid) {
      this.logger.error('outbound volume warning could not reach owner (no owner JID available)');
      return;
    }

    try {
      // This is sent on the original transport while the current queue item is
      // active; routing it back through the queue here would deadlock at
      // concurrency 1. It is one owner-only safety alert, not user traffic.
      const content = {
        text:
          `⚠️ Outbound volume warning.\n\n` +
          `${count} successful messages were sent across chats within ${seconds}s ` +
          `(threshold: ${this.volumeLimit}). Sending continues under normal limits; ` +
          `use ".panic" if this was unexpected.`,
      };
      this.#notifyBeforeSend(ownerJid, content);
      await this.rawSendMessage(ownerJid, content);
    } catch (error) {
      this.logger.error(`outbound volume owner alert failed: ${error.message}`);
    }
  }

  async #tripLoopBreaker(item, { destination, count }) {
    this.stats.loopBreakerTrips++;
    this.stats.dropped++;
    this.halt('loop-breaker');
    item.reject(new Error('outbound loop breaker engaged; outbound halted'));
    this.logger.error(
      `outbound loop breaker engaged: blocked similar message ${count} to ${destination} ` +
        `within ${this.loopWindowMs}ms`
    );

    const ownerJid =
      normalizeJid(this.socket?.user?.id) || normalizeJid(this.config?.safety?.ownerJids?.[0]);
    if (!ownerJid) {
      this.logger.error('loop breaker stopped outbound traffic but could not alert owner (no owner JID available)');
      return;
    }

    this.allowOnce();
    const seconds = Math.ceil(this.loopWindowMs / 1_000);
    try {
      await this.socket.sendMessage(ownerJid, {
        text:
          `🛑 Outbound loop breaker engaged.\n\n` +
          `Blocked similar message ${count} to ${destination} within ${seconds}s. ` +
          `Further sends are halted. Fix the source, then run ".panic resume" or restart Nexus-WA.\n` +
          `Message text is not included in this alert.`,
      });
    } catch (error) {
      this.logger.error(`loop breaker owner alert failed: ${error.message}`);
    }
  }

  async #pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const item = this.queue.shift();

      // Wait out the per-chat budget rather than dropping the message.
      if (item.jid && !this.#withinBudget(item.jid)) {
        const wait = this.#msUntilSlot(item.jid);
        this.stats.throttledMs += wait;
        this.logger.warn(
          `rate limit hit for ${item.jid} — holding ${Math.round(wait)}ms ` +
            `(${this.limitPerMin}/min)`
        );
        // Re-queue at the front and wait.
        this.queue.unshift(item);
        await sleep(wait);
        continue;
      }

      if (!item.bypassSafetyMonitors) {
        const trip = this.#checkLoop(item);
        if (trip) {
          await this.#tripLoopBreaker(item, trip);
          continue;
        }
      }

      this.active++;
      this.#run(item).finally(() => {
        this.active--;
        this.#pump();
      });
    }
  }

  #msUntilSlot(jid) {
    const win = this.windows.get(jid) || [];
    if (!win.length) return 0;
    return Math.max(0, this.windowMs - (Date.now() - win[0]) + 50);
  }

  async #run(item) {
    try {
      if (this.typing && item.jid) await this.#simulateTyping(item.jid);
      this.#notifyBeforeSend(item.jid, item.content);
      const res = await item.task();
      if (item.jid) {
        this.windows.set(item.jid, [...(this.windows.get(item.jid) || []), Date.now()]);
      }
      this.stats.sent++;
      if (!item.bypassSafetyMonitors) {
        const anomaly = this.#checkVolumeAnomaly();
        if (anomaly) await this.#alertVolumeAnomaly(anomaly);
      }
      item.resolve(res);
    } catch (err) {
      this.logger.error(`send failed: ${err.message}`);
      item.reject(err);
    }
  }

  /** Human-ish pause: a short beat plus time proportional to length. */
  async #simulateTyping(jid) {
    try {
      await this.socket.sendPresenceUpdate?.('composing', jid);
      this.stats.typing++;
      // 40ms/char, clamped so a 4000-char message doesn't stall for minutes.
      const ms = 600 + Math.min(2500, Math.round(Math.random() * 400));
      await sleep(ms);
      await this.socket.sendPresenceUpdate?.('paused', jid);
    } catch {
      // Presence is best-effort; never fail a send over it.
    }
  }

  depth() {
    return { queued: this.queue.length, active: this.active, halted: this.halted, ...this.stats };
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default OutboundQueue;
