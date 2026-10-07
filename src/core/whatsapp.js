/**
 * Nexus-WA — Baileys WhatsApp connection.
 *
 * ⚠️ NOT EXERCISED IN THIS SANDBOX. There is no WhatsApp account and no
 * Telegram token here, so the socket handshake, pairing flow and reconnect
 * behaviour are written against the verified v7 API surface but have not been
 * run against Meta's servers. Everything that CAN be verified locally is
 * covered by tests (auth-state persistence, disconnect classification, the
 * reconnect policy, the outbound queue). Validate this file on a burner first —
 * see docs/PREVIEW.md rung 1.
 *
 * Baileys is imported dynamically so `--dry-run` never loads it at all: a
 * process that cannot connect cannot get you banned.
 */

import fs from 'node:fs';
import { OutboundQueue } from './outboundQueue.js';
import { normalizeJid } from './jid.js';

let lib = null;
async function baileys() {
  if (!lib) lib = await import('@whiskeysockets/baileys');
  return lib;
}

/**
 * Classify a disconnect into an action. Pure and exported for testing — this
 * is the logic that decides whether a drop is worth panicking about.
 *
 * @returns {'restart'|'relogin'|'backoff'|'ignore'}
 */
export function classifyDisconnect(reason, DisconnectReason) {
  const D = DisconnectReason || {};
  // Guard first. Without it, `case D.loggedOut` degrades to `case undefined`
  // when the enum isn't supplied — which would classify a plain network drop
  // (no status code) as a logout and wipe the stored credentials.
  if (reason === undefined || reason === null) return 'backoff';

  switch (reason) {
    case D.loggedOut:
    case 401:
      // Session revoked (logged out from the phone). Retrying is pointless and
      // looks like an attacker; wipe credentials and ask for a fresh link.
      return 'relogin';
    case D.restartRequired:
    case 515:
    case D.timedOut:
    case 408:
      return 'restart';
    case D.multideviceMismatch:
    case 411:
      return 'relogin';
    case D.badSession:
    case 500:
    case D.connectionClosed:
    case D.connectionLost:
    case D.connectionReplaced:
    case 503:
    case D.unavailableService:
      return 'restart';
    case D.forbidden:
    case 403:
    case 440:
    case 428:
      // Possible restriction. Stop rather than hammering.
      return 'relogin';
    default:
      return 'backoff';
  }
}

/** Exponential backoff with jitter, capped. Pure, for testing. */
export function backoffDelay(attempt, { baseMs = 3000, maxMs = 60000 } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export class WhatsAppConnection {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger.child({ scope: 'whatsapp' });
    this.socket = null;
    this.saveCreds = null;
    this.attempt = 0;
    this.stopped = false;
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }

  #emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      try {
        fn(payload);
      } catch (err) {
        this.logger.error(`listener ${event}: ${err.message}`);
      }
    }
  }

  async connect() {
    const B = await baileys();
    const { useMultiFileAuthState, makeWASocket, DisconnectReason } = B;

    fs.mkdirSync(this.config.wa.sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.config.wa.sessionDir);
    this.saveCreds = saveCreds;

    const version = await this.#version(B);

    const socket = makeWASocket({
      auth: state,
      version,
      logger: this.logger.child({ scope: 'baileys' }),
      browser: this.config.wa.browser,
      // Print the QR in the terminal only when there is no Telegram panel to
      // deliver it to — you should never need a terminal to link this bot.
      printQRInTerminal: !this.config.telegram.enabled,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      qrTimeout: 60_000,
      retryRequestDelayMs: 5000,
      maxMsgRetryCount: 5,
      getMessage: async () => undefined,
    });

    // Structural rate limiting — nothing can send around this.
    new OutboundQueue(socket, this.config, this.logger).attach();

    this.socket = socket;
    this.#wire(socket, DisconnectReason);
    this.logger.info(
      `connecting… (session: ${this.config.wa.sessionDir}` +
        `${state.creds?.me ? ', resuming as ' + state.creds.me.id : ', fresh link'})`
    );
    return socket;
  }

  async #version(B) {
    try {
      const { version, isLatest } = await B.fetchLatestBaileysVersion();
      this.logger.info(`wa web version ${version.join('.')} (latest=${isLatest})`);
      return version;
    } catch (err) {
      this.logger.warn(`could not fetch latest version (${err.message}); using library default`);
      return undefined;
    }
  }

  #wire(socket, DisconnectReason) {
    socket.ev.on('creds.update', () => this.saveCreds?.());

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.info('QR code generated');
        this.#emit('qr', qr);
      }

      if (connection === 'open') {
        this.attempt = 0;
        const me = normalizeJid(socket.user?.id || '');
        this.logger.info(`connected as ${me}`);

        if (this.config.wa.pairingNumber && !socket.authState?.creds?.registered) {
          await this.#requestPairingCode(socket);
        }
        this.#emit('open', { jid: me, pushName: socket.user?.name || null });
        return;
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const action = classifyDisconnect(reason, DisconnectReason);
        this.logger.warn(`connection closed (code=${reason ?? 'none'}) → ${action}`);
        this.#emit('close', { reason, action });

        if (this.stopped) return;

        if (action === 'relogin') {
          this.logger.error('session is no longer valid — credentials must be re-linked');
          this.#emit('relogin', { reason });
          return;
        }
        this.attempt++;
        const delay = backoffDelay(this.attempt);
        this.logger.info(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.attempt})`);
        setTimeout(() => {
          if (!this.stopped) this.connect().catch((e) => this.logger.error(e.message));
        }, delay);
      }
    });

    socket.ev.on('messages.upsert', (p) => this.#emit('messages.upsert', p));
    socket.ev.on('messages.update', (p) => this.#emit('messages.update', p));
    socket.ev.on('contacts.update', (p) => this.#emit('contacts.update', p));
    socket.ev.on('messaging-history.set', (p) => this.#emit('messaging-history.set', p));
  }

  async #requestPairingCode(socket) {
    const number = this.config.wa.pairingNumber;
    try {
      // Baileys requires the number to be "registered" with the socket first.
      const code = await socket.requestPairingCode(number);
      this.logger.info(`pairing code: ${code}`);
      this.#emit('pairing-code', code);
      return code;
    } catch (err) {
      this.logger.error(`pairing code request failed: ${err.message}`);
      this.#emit('pairing-error', err.message);
      return null;
    }
  }

  /** Delete stored credentials so the next start produces a fresh QR. */
  async resetSession() {
    const dir = this.config.wa.sessionDir;
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.logger.warn(`wiped session directory ${dir}`);
  }

  async stop() {
    this.stopped = true;
    try {
      await this.socket?.end?.();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Entry point used by index.js.
 * @returns {Promise<object>} the rate-limited socket
 */
export async function connectWhatsApp({ config, logger, hooks = {} }) {
  const conn = new WhatsAppConnection({ config, logger });
  for (const [event, fn] of Object.entries(hooks)) conn.on(event, fn);
  const socket = await conn.connect();
  socket.__connection = conn;
  return socket;
}

export default { connectWhatsApp, WhatsAppConnection, classifyDisconnect, backoffDelay };
