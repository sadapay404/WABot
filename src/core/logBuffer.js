/**
 * Nexus-WA — in-memory log ring buffer.
 *
 * `/logs` in the Telegram panel and the dashboard both read from here. A ring
 * buffer rather than a file so there is nothing to rotate on an ephemeral
 * PaaS filesystem; the trade-off is that history dies with the process.
 */

import { addLogSink } from './logger.js';

export class LogBuffer {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
    this.detach = null;
  }

  attach() {
    this.detach = addLogSink((e) => {
      this.entries.push({ ...e, at: Date.now() });
      if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    });
    return this;
  }

  tail(n = 50, { level } = {}) {
    const all = level ? this.entries.filter((e) => e.level === level) : this.entries;
    return all.slice(-n);
  }

  text(n = 50, opts = {}) {
    const lines = this.tail(n, opts).map((e) => `${e.ts} ${e.level.toUpperCase()} [${e.scope}] ${e.message}`);
    return lines.length ? lines.join('\n') : '(no log lines yet)';
  }

  clear() {
    this.entries = [];
  }
}

export default LogBuffer;
