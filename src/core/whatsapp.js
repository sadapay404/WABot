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
/** Exit code meaning "do not restart me": the supervisor stops, a human must act. */
export const EXIT_DO_NOT_RESTART = 3;

/**
 * Liveness limits. Baileys pings the server about every 30s and the server
 * answers, so inbound frames keep arriving on a healthy link. These limits only
 * trip when the link is dead, which is what a Wi-Fi drop usually leaves behind:
 * a socket that never reports `close`.
 */
export const VERSION_TIMEOUT_MS = 10_000;
export const CONNECT_STALL_MS = 120_000;
export const SILENCE_MS = 180_000;
export const HEALTH_TICK_MS = 30_000;

/**
 * Decide whether the connection needs a nudge. Pure, so it can be tested.
 * @returns {null|{action:'reconnect'|'schedule', reason:string}}
 */
export function livenessAction({ state, now, lastFrameAt, stateSince, awaitingLink = false, reconnectPending = false }) {
  if (state === 'open' && now - lastFrameAt > SILENCE_MS) {
    return { action: 'reconnect', reason: `no traffic from WhatsApp for ${Math.round((now - lastFrameAt) / 1000)}s` };
  }
  if (state === 'connecting' && !awaitingLink && now - stateSince > CONNECT_STALL_MS) {
    return { action: 'reconnect', reason: `connection attempt stalled for ${Math.round((now - stateSince) / 1000)}s` };
  }
  if (state === 'closed' && !reconnectPending) {
    return { action: 'schedule', reason: 'no reconnect was pending' };
  }
  return null;
}

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
    case D.connectionReplaced:
    case 440:
      // Another device took this session. Reconnecting would just take it back
      // and loop forever, so stop; the device that was started last keeps it.
      return 'replaced';
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

/** Request a phone-number pairing code when Baileys first offers a QR. */
export function shouldRequestPairingCode({ qr, pairingNumber, registered, requested }) {
  return Boolean(qr && pairingNumber && !registered && !requested);
}

/** Pair codes need Baileys' canonical platform descriptor, not our app brand. */
export function connectionBrowser(B, config) {
  if (config.wa.companionProfile === 'smb_android') return B.Browsers.android('13');
  return config.wa.pairingNumber ? B.Browsers.ubuntu('Chrome') : config.wa.browser;
}

/** Match the familiar XXXX-XXXX presentation; the code itself is unchanged. */
export function formatPairingCode(code) {
  const value = String(code ?? '');
  return value.match(/.{1,4}/g)?.join('-') || value;
}

export class WhatsAppConnection {
  constructor({ config, logger, cache = null }) {
    this.config = config;
    this.cache = cache;
    this.logger = logger.child({ scope: 'whatsapp' });
    this.socket = null;
    this.saveCreds = null;
    this.attempt = 0;
    this.stopped = false;
    this.listeners = new Map();
    // 'idle' | 'connecting' | 'open' | 'closed'
    this.state = 'idle';
    this.stateSince = Date.now();
    this.lastFrameAt = 0;
    // Last incoming message. Starts at boot, so a quiet fresh start is not "deaf".
    this.lastInboundAt = Date.now();
    // Bumped whenever an attempt is abandoned, so a late-finishing connect()
    // cannot create a second socket beside the one that replaced it.
    this.generation = 0;
    this.reconnectTimer = null;
    this.healthTimer = null;
    // True after a non-retryable failure. The health tick must not revive it.
    this.halted = false;
    // True while a fresh link is waiting for the user to scan or enter a code.
    // That can take minutes, so the connect-stall check must not fire then.
    this.awaitingLink = false;
    // Optional. The health tick writes a small key=value file here so the
    // Termux watchdog can notice a bot whose event loop has wedged.
    this.heartbeatFile = process.env.NEXUS_HEARTBEAT_FILE || null;
  }

  #setState(state) {
    this.state = state;
    this.stateSince = Date.now();
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
    const generation = ++this.generation;
    this.#setState('connecting');
    this.#startHealthTick();
    const B = await baileys();
    const { useMultiFileAuthState, makeWASocket, DisconnectReason, Browsers } = B;

    fs.mkdirSync(this.config.wa.sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.config.wa.sessionDir);
    this.saveCreds = saveCreds;

    const companionProfile = this.config.wa.companionProfile || 'web';
    if (companionProfile === 'smb_android' && state.creds?.me) {
      const err = new Error(
        'WA_COMPANION_PROFILE=smb_android only applies during a fresh link. ' +
          'Use a new WA_SESSION_DIR for the Business companion; the existing auth directory was not changed.'
      );
      err.fatal = true; // a config error: retrying every minute would not help
      throw err;
    }

    const version = await this.#version(B);
    if (generation !== this.generation) return null; // superseded while awaiting
    const browser = connectionBrowser({ Browsers }, this.config);

    const socket = makeWASocket({
      auth: state,
      version,
      logger: this.logger.child({ scope: 'baileys' }),
      browser,
      // Baileys rc14 needs a small local patch for the Business-only SMB_ANDROID
      // UserAgent/webInfo/CHROME registration combination.
      nexusCompanionProfile: companionProfile,
      ...(companionProfile === 'smb_android'
        ? { nexusCompanionPlatformDisplay: 'Chrome (Ubuntu)' }
        : {}),
      // The phone-number flow does not need a QR printed into the log. Keep
      // Baileys' legacy QR printer only as a fallback when neither pairing
      // number nor Telegram delivery is configured.
      printQRInTerminal: !this.config.wa.pairingNumber && !this.config.telegram.enabled,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      qrTimeout: 60_000,
      retryRequestDelayMs: 5000,
      maxMsgRetryCount: 5,
      // Keep original protobufs in the bounded in-memory cache so Baileys can
      // decrypt secret-encrypted MESSAGE_EDIT envelopes. Cache lookups verify
      // the message ID, conversation, and direction before returning content.
      getMessage: async (key) => this.cache?.getMessage?.(key),
    });

    // Structural rate limiting — nothing can send around this. One queue for the
    // whole process, re-attached to each new socket, so halt/resume and pacing
    // survive reconnects.
    if (!this.queue) this.queue = new OutboundQueue(socket, this.config, this.logger);
    this.queue.socket = socket;
    this.queue.attach();

    this.socket = socket;
    this.lastFrameAt = Date.now();
    // Baileys emits 'frame' for every decoded inbound frame. This is the real
    // "is the link alive" signal.
    socket.ws?.on?.('frame', () => {
      this.lastFrameAt = Date.now();
    });
    this.#wire(socket, DisconnectReason);
    this.logger.info(
      `connecting… (account platform: ${state.creds?.platform || 'not recorded'}; ` +
        `requested companion: ${companionProfile} (${browser[0]}/${browser[1]}); ` +
        `session: ${this.config.wa.sessionDir}` +
        `${state.creds?.me ? ', resuming as ' + state.creds.me.id : ', fresh link'})`
    );
    return socket;
  }

  async #version(B) {
    // fetchLatestBaileysVersion has no timeout of its own. On a dead network it
    // can hang indefinitely, and connect() would never create a socket.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), VERSION_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      const { version, isLatest } = await Promise.race([B.fetchLatestBaileysVersion(), timeout]);
      this.logger.info(`wa web version ${version.join('.')} (latest=${isLatest})`);
      return version;
    } catch (err) {
      this.logger.warn(`could not fetch latest version (${err.message}); using library default`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The only place that schedules a reconnect. A single timer means two drops
   * can never create two sockets, and a failed connect() schedules another try
   * instead of leaving the bot silently offline.
   */
  #scheduleReconnect(reason, { immediate = false } = {}) {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.attempt++;
    const delay = immediate ? 0 : backoffDelay(this.attempt);
    this.logger.info(
      `reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.attempt})${reason ? ` — ${reason}` : ''}`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connect().catch((err) => {
        this.logger.error(`reconnect failed: ${err.message}`);
        this.#setState('closed');
        if (err.fatal) this.halted = true;
        else this.#scheduleReconnect('connect failed');
      });
    }, delay);
    // This is a long-running bot process. Keeping the reconnect timer referenced
    // is intentional: after a 503/connection-loss close it may be the ONLY
    // remaining event-loop handle. An unref'ed timer lets Node exit before the
    // scheduled reconnect fires, which looks like a nightly bot shutdown.
  }

  /**
   * Abandon the current socket (or a hung connect attempt) and reconnect now.
   * Used by the health tick. The old socket's close event is ignored as stale.
   */
  forceReconnect(reason) {
    if (this.stopped) return;
    this.logger.warn(`forcing reconnect: ${reason}`);
    this.generation++; // abandon any connect() still awaiting
    const socket = this.socket;
    this.#setState('closed');
    if (socket) {
      try {
        socket.end(new Error(reason));
      } catch {
        /* already gone */
      }
    }
    this.#scheduleReconnect(reason, { immediate: true });
  }

  #startHealthTick() {
    if (this.healthTimer || this.stopped) return;
    // Keep the daemon alive even when a broken websocket has dropped every
    // other event-loop handle. stop() always clears this during intentional
    // shutdown, logout, or session replacement.
    this.healthTimer = setInterval(() => this.#healthTick(), HEALTH_TICK_MS);
  }

  #healthTick() {
    if (this.stopped) return;
    const now = Date.now();
    this.#writeHeartbeat(now);
    if (this.halted) return;
    const verdict = livenessAction({
      state: this.state,
      now,
      lastFrameAt: this.lastFrameAt,
      stateSince: this.stateSince,
      awaitingLink: this.awaitingLink,
      reconnectPending: Boolean(this.reconnectTimer),
    });
    if (!verdict) return;
    if (verdict.action === 'reconnect') this.forceReconnect(verdict.reason);
    else this.#scheduleReconnect(verdict.reason);
  }

  #writeHeartbeat(now) {
    if (!this.heartbeatFile) return;
    try {
      const body = [
        `ts=${Math.floor(now / 1000)}`,
        `state=${this.state}`,
        `state_since=${Math.floor(this.stateSince / 1000)}`,
        `last_frame=${Math.floor(this.lastFrameAt / 1000)}`,
        `queue_halted=${this.queue?.halted ? this.queue.haltReason : 'no'}`,
        `queue_queued=${this.queue ? this.queue.depth().queued : 0}`,
        `last_inbound=${Math.floor(this.lastInboundAt / 1000)}`,
        `last_sent=${this.queue?.lastSentAt ? Math.floor(this.queue.lastSentAt / 1000) : 0}`,
        '',
      ].join('\n');
      const tmp = `${this.heartbeatFile}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, this.heartbeatFile);
    } catch (err) {
      this.logger.warn(`heartbeat write failed: ${err.message}`);
    }
  }

  #wire(socket, DisconnectReason) {
    socket.ev.on('creds.update', () => this.saveCreds?.());
    let pairingRequested = false;

    socket.ev.on('connection.update', async (update) => {
      // A socket we already replaced (forced reconnect) can still emit events.
      // Acting on them would start a second connection beside the live one.
      if (socket !== this.socket) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.info('QR code generated');
        this.#emit('qr', qr);

        // A fresh account never reaches connection='open' until it has been
        // linked. Ask for the pairing code as soon as Baileys emits its first
        // QR (the websocket is ready to accept the link-code request then).
        this.awaitingLink = true;
        if (shouldRequestPairingCode({
          qr,
          pairingNumber: this.config.wa.pairingNumber,
          registered: socket.authState?.creds?.registered,
          requested: pairingRequested,
        })) {
          pairingRequested = true;
          await this.#requestPairingCode(socket);
        }
      }

      if (connection === 'open') {
        this.attempt = 0;
        this.#setState('open');
        this.awaitingLink = false;
        this.lastFrameAt = Date.now();
        const me = normalizeJid(socket.user?.id || '');
        this.logger.info(`connected as ${me}`);
        this.#emit('open', { jid: me, pushName: socket.user?.name || null });
        return;
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const action = classifyDisconnect(reason, DisconnectReason);
        this.logger.warn(`connection closed (code=${reason ?? 'none'}) → ${action}`);
        this.#setState('closed');
        this.#emit('close', { reason, action });

        if (this.stopped) return;

        if (action === 'replaced') {
          this.logger.error(
            'this session was taken over by another device — stopping so the two do not fight. '
              + 'Start this one again with: nexus start (only after the other device is stopped)'
          );
          this.#emit('replaced', { reason });
          setTimeout(() => process.exit(EXIT_DO_NOT_RESTART), 1500);
          return;
        }
        if (action === 'relogin') {
          // Nothing the bot can do without a human: exit so the supervisor stops
          // instead of leaving a silent, disconnected process behind.
          this.logger.error(
            'session is no longer valid — re-link WhatsApp with: nexus pair. The bot will not restart by itself.'
          );
          this.#emit('relogin', { reason });
          setTimeout(() => process.exit(EXIT_DO_NOT_RESTART), 1500);
          return;
        }
        this.#scheduleReconnect();
      }
    });

    socket.ev.on('messages.upsert', (p) => {
      this.lastInboundAt = Date.now();
      this.#emit('messages.upsert', p);
    });
    socket.ev.on('messages.update', (p) => this.#emit('messages.update', p));
    socket.ev.on('contacts.update', (p) => this.#emit('contacts.update', p));
    socket.ev.on('chats.update', (p) => this.#emit('chats.update', p));
    socket.ev.on('chats.upsert', (p) => this.#emit('chats.upsert', p));
    socket.ev.on('messaging-history.set', (p) => this.#emit('messaging-history.set', p));
  }

  async #requestPairingCode(socket) {
    const number = this.config.wa.pairingNumber;
    try {
      const code = await socket.requestPairingCode(number);
      this.logger.info(`pairing code: ${formatPairingCode(code)}`);
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
    clearTimeout(this.reconnectTimer);
    clearInterval(this.healthTimer);
    this.reconnectTimer = null;
    this.healthTimer = null;
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
