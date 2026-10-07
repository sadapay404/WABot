/**
 * Nexus-WA — outbound queue.
 *
 * Every message the bot sends goes through here, including scheduled ones, so
 * nothing can bypass the pacing. Three things it does that a raw socket does
 * not:
 *
 *   1. serialises sends (concurrency 1) — bursts are the loudest signal an
 *      unofficial client can emit
 *   2. enforces a per-chat per-minute budget
 *   3. shows a typing/composing presence and waits a beat proportional to the
 *      message length, so replies look like they were typed by a person
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

    /** Kill-switch state. When true nothing leaves the process. */
    this.halted = false;
    /** One-shot passes through the kill-switch (see allowOnce). */
    this.escape = 0;

    /** @type {Map<string, number[]>} jid -> send timestamps */
    this.windows = new Map();
    this.queue = [];
    this.active = 0;
    this.stats = { sent: 0, throttledMs: 0, dropped: 0, typing: 0 };
  }

  /** Wrap a socket so sendMessage is rate-limited. Mutates and returns it. */
  attach() {
    const original = this.socket.sendMessage.bind(this.socket);
    const self = this;

    this.socket.sendMessage = function queuedSendMessage(jid, content, options) {
      return self.#enqueue(() => original(jid, content, options), jid);
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

  #enqueue(task, jid) {
    return new Promise((resolve, reject) => {
      if (this.halted) {
        // A single explicit pass lets a command confirm the halt it just
        // caused. Without it `.panic` engages and then cannot tell the owner
        // it engaged — so they have no way to know whether to send `resume`.
        if (this.escape > 0) {
          this.escape--;
        } else {
          this.stats.dropped++;
          return reject(new Error('outbound halted by kill-switch'));
        }
      }
      this.queue.push({ task, jid, resolve, reject });
      this.#pump();
    });
  }

  /**
   * Panic stop. Drops everything queued and refuses new sends until resume().
   * @returns {number} how many queued messages were discarded
   */
  halt() {
    this.halted = true;
    const dropped = this.queue.length;
    const pending = this.queue.splice(0, this.queue.length);
    for (const item of pending) {
      this.stats.dropped++;
      item.reject(new Error('outbound halted by kill-switch'));
    }
    this.logger.warn(`KILL-SWITCH engaged — dropped ${dropped} queued message(s)`);
    return dropped;
  }

  /**
   * Let exactly one further send through the kill-switch. Used by the command
   * that engages the switch so it can confirm itself to the owner. Deliberately
   * a single message — it is not a bypass for bulk sends.
   */
  allowOnce() {
    this.escape++;
  }

  resume() {
    this.halted = false;
    this.escape = 0;
    this.logger.info('kill-switch released — outbound resumed');
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
      const res = await item.task();
      if (item.jid) {
        this.windows.set(item.jid, [...(this.windows.get(item.jid) || []), Date.now()]);
      }
      this.stats.sent++;
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
