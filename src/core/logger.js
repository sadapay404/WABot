/**
 * Nexus-WA — structured logger.
 *
 * Zero-dependency and deliberately pino-COMPATIBLE: it exposes
 * child()/trace()/debug()/info()/warn()/error()/fatal(), so it can be handed
 * straight to `makeWASocket({ logger })` in Phase 1 without an adapter.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

const COLOR = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41;97m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const isTTY = process.stdout.isTTY && !process.env.CI;

/**
 * Module-level sinks, so every child logger feeds the same ring buffer that
 * powers /logs in the Telegram panel and the log tab of the dashboard.
 */
const sinks = new Set();
export function addLogSink(fn) {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

function makeLogger(level = 'info', scope = 'nexus', bindings = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (lvl, args) => {
    if (LEVELS[lvl] < threshold) return;

    const ts = new Date().toISOString().slice(11, 23);
    const scopeTxt = scope === 'nexus' ? '' : ` ${DIM}[${scope}]${RESET}`;
    const head = `${DIM}${ts}${RESET} ${COLOR[lvl]}${lvl.toUpperCase().padEnd(5)}${RESET}${scopeTxt}`;

    let line = `${head} `;
    const extras = [];
    for (const a of args) {
      if (a instanceof Error) extras.push(a.stack || String(a));
      else if (typeof a === 'object' && a !== null) extras.push(JSON.stringify(a));
      else line += `${a} `;
    }
    const stream = LEVELS[lvl] >= LEVELS.error ? process.stderr : process.stdout;
    stream.write(`${line.trimEnd()}${extras.length ? `\n      ${extras.join('\n      ')}` : ''}\n`);

    if (sinks.size) {
      const plain = args
        .map((a) =>
          a instanceof Error ? a.message : typeof a === 'object' ? JSON.stringify(a) : String(a)
        )
        .join(' ');
      const entry = { level: lvl, scope, ts, message: plain };
      for (const sink of sinks) {
        try {
          sink(entry);
        } catch {
          /* a broken sink must never break logging */
        }
      }
    }
  };

  const logger = {};
  for (const lvl of Object.keys(LEVELS)) {
    logger[lvl] = (...args) => write(lvl, args);
  }
  logger.level = level;
  logger.child = (more) =>
    makeLogger(level, more.scope ? `${scope}:${more.scope}` : scope, { ...bindings, ...more });
  logger.bindings = bindings;
  // pino compatibility shim
  logger.isLevelEnabled = (lvl) => (LEVELS[lvl] ?? 0) >= threshold;
  return logger;
}

export function createLogger(level, scope) {
  return makeLogger(level, scope);
}

export default createLogger;
