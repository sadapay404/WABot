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
import path from 'node:path';
import { OutboundQueue } from './outboundQueue.js';
import { normalizeJid } from './jid.js';

let lib = null;
async function baileys() {
  if (!lib) lib = await import('@whiskeysockets/baileys');
  return lib;
}

/** Extract the version safely from Baileys' public Defaults source. */
export function parseBaileysVersionSource(source) {
  const match = String(source || '').match(/const\s+version\s*=\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/);
  if (!match) throw new Error('GitHub Defaults source did not contain a WhatsApp version');
  return match.slice(1).map(Number);
}

/**
 * The upstream helper uses raw.githubusercontent.com, which is often blocked
 * or slow on PaaS hosts. The GitHub REST API is more consistently reachable
 * there and returns the same public Defaults source as base64 JSON.
 */
export async function fetchBaileysVersionFromGitHub({ fetchImpl = globalThis.fetch, signal } = {}) {
  const response = await fetchImpl(BAILEYS_DEFAULTS_API, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'Nexus-WA version check',
    },
    signal,
  });
  if (!response?.ok) throw new Error(`GitHub version request failed (${response?.status || 'no response'})`);
  const body = await response.json();
  const source = Buffer.from(String(body?.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  return parseBaileysVersionSource(source);
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
export const VERSION_CACHE_MS = 24 * 60 * 60 * 1000;
const BAILEYS_DEFAULTS_API = 'https://api.github.com/repos/WhiskeySockets/Baileys/contents/src/Defaults/index.ts';
export const CONNECT_STALL_MS = 120_000;
// Baileys' decoded protocol keepalive is the authoritative open-link signal.
// Keep this exported for compatibility, but do not recycle an open socket only
// because application traffic is quiet.
export const SILENCE_MS = 180_000;
export const STABLE_OPEN_MS = 60_000;
export const HEALTH_TICK_MS = 30_000;

/**
 * Decide whether the connection needs a nudge. Pure, so it can be tested.
 * @returns {null|{action:'reconnect'|'schedule', reason:string}}
 */
export function livenessAction({ state, now, lastFrameAt, stateSince, awaitingLink = false, reconnectPending = false }) {
  // `frame` is useful telemetry, but Baileys owns protocol keepalive. A quiet
  // conversation must not make us tear down an authenticated socket.
  if (state === 'connecting' && !awaitingLink && now - stateSince > CONNECT_STALL_MS) {
    return { action: 'reconnect', reason: `connection attempt stalled for ${Math.round((now - stateSince) / 1000)}s` };
  }
  if (state === 'closed' && !reconnectPending) {
    return { action: 'schedule', reason: 'no reconnect was pending' };
  }
  return null;
}

export function classifyDisconnect(reason, DisconnectReason = null) {
  // Baileys' enum values are numeric. Keep the public enum argument for
  // callers/tests, but do not let missing or aliased enum properties change a
  // numeric disconnect policy (notably 428 = connectionClosed).
  const code = Number(reason);
  if (!Number.isFinite(code)) return 'backoff';
  if (code === 440) return 'replaced';
  if (code === 401 || code === 403 || code === 411) return 'relogin';
  if ([408, 428, 500, 503, 515].includes(code)) return 'restart';
  return 'backoff';
}

/** Exponential backoff with jitter, capped. Pure, for testing. */
// A transport outage can last hours. Cap the reconnect *rate* at five minutes,
// not one minute: repeatedly making fresh WebSocket handshakes while the route
// is unhealthy is noisy, wastes a constrained host, and makes session-state
// errors harder to diagnose. A stable open still resets the streak after 60s.
export const RECONNECT_MAX_DELAY_MS = 5 * 60_000;

export function backoffDelay(attempt, { baseMs = 3000, maxMs = RECONNECT_MAX_DELAY_MS } = {}) {
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

/**
 * Keep the companion explicitly offline after every (re)connect. WhatsApp
 * suppresses audible notifications on the primary phone while another linked
 * device is considered active; reconnects can otherwise leave that state
 * behind even though `markOnlineOnConnect` is false. This is presence-only:
 * it neither reads messages nor changes phone notification settings.
 */
export async function preservePrimaryPhoneNotifications(socket, logger = null) {
  if (typeof socket?.sendPresenceUpdate !== 'function') return false;
  try {
    await socket.sendPresenceUpdate('unavailable');
    return true;
  } catch (error) {
    logger?.warn?.(`could not mark companion unavailable: ${error.message}`);
    return false;
  }
}

export class WhatsAppConnection {
  constructor({ config, logger, cache = null }) {
    this.config = config;
    this.cache = cache;
    this.logger = logger.child({ scope: 'whatsapp' });
    this.socket = null;
    this.socketGeneration = 0;
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
    this.stableOpenTimer = null;
    this.retryTicket = 0;
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

  #owns(socket, generation) {
    return !this.stopped && !this.halted && this.generation === generation && this.socket === socket;
  }

  #cancelStableOpen() {
    clearTimeout(this.stableOpenTimer);
    this.stableOpenTimer = null;
  }

  #markTerminal(kind, reason) {
    if (this.halted) return;
    this.halted = true;
    this.generation++;
    this.retryTicket++;
    this.awaitingLink = false;
    this.#cancelStableOpen();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.logger.error(`terminal-stop kind=${kind} code=${reason ?? 'none'}`);
  }

  #scheduleStableOpen(socket, generation) {
    this.#cancelStableOpen();
    this.stableOpenTimer = setTimeout(() => {
      if (!this.#owns(socket, generation) || this.state !== 'open') return;
      this.attempt = 0;
      this.logger.info(`connection stable generation=${generation}; reconnect backoff reset`);
    }, STABLE_OPEN_MS);
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }

  #emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      try {
        // EventEmitter does not await async listeners. Attach a rejection
        // handler here so an optional watcher cannot become an unhandled
        // rejection that kills the whole live process.
        const result = fn(payload);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => this.logger.error(`listener ${event}: ${error.message}`));
        }
      } catch (error) {
        this.logger.error(`listener ${event}: ${error.message}`);
      }
    }
  }

  async connect() {
    if (this.stopped || this.halted) return null;
    const generation = ++this.generation;
    this.#setState('connecting');
    this.#startHealthTick();

    const B = await baileys();
    if (this.stopped || this.halted || generation !== this.generation) return null;
    const { useMultiFileAuthState, makeWASocket, DisconnectReason, Browsers } = B;

    fs.mkdirSync(this.config.wa.sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.config.wa.sessionDir);
    if (this.stopped || this.halted || generation !== this.generation) return null;

    const companionProfile = this.config.wa.companionProfile || 'web';
    // A linked SMB_ANDROID companion must be allowed to resume after a normal
    // restartRequired reconnect. We do not migrate or overwrite credentials.
    const version = await this.#version();
    if (this.stopped || this.halted || generation !== this.generation) return null;
    const browser = connectionBrowser({ Browsers }, this.config);

    const socket = makeWASocket({
      auth: state,
      version,
      logger: this.logger.child({ scope: 'baileys' }),
      browser,
      nexusCompanionProfile: companionProfile,
      ...(companionProfile === 'smb_android' ? { nexusCompanionPlatformDisplay: 'Chrome (Ubuntu)' } : {}),
      printQRInTerminal: !this.config.wa.pairingNumber && !this.config.telegram.enabled,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      qrTimeout: 60_000,
      retryRequestDelayMs: 5000,
      maxMsgRetryCount: 5,
      getMessage: async (key) => this.cache?.getMessage?.(key),
    });
    if (this.stopped || this.halted || generation !== this.generation) {
      try { socket.end?.(new Error('superseded connection attempt')); } catch { /* ignored */ }
      return null;
    }

    if (!this.queue) this.queue = new OutboundQueue(socket, this.config, this.logger);
    this.queue.attach(socket);
    this.socket = socket;
    this.socketGeneration = generation;
    this.lastFrameAt = Date.now();
    socket.ws?.on?.('frame', () => {
      if (this.#owns(socket, generation)) this.lastFrameAt = Date.now();
    });
    this.#wire(socket, DisconnectReason, generation, saveCreds);
    this.logger.info(`connection attempt ready generation=${generation} profile=${companionProfile}`);
    return socket;
  }

  #versionCachePath() {
    // Keep the non-secret cache beside, not inside, the Baileys auth directory:
    // its presence must never make an empty credential directory look linked
    // and prevent a legitimate remote-vault restore.
    return path.join(path.dirname(this.config.wa.sessionDir), 'wa-web-version.json');
  }

  #readVersionCache() {
    try {
      const value = JSON.parse(fs.readFileSync(this.#versionCachePath(), 'utf8'));
      const version = Array.isArray(value?.version) ? value.version.map(Number) : [];
      const fetchedAt = Number(value?.fetchedAt);
      if (version.length !== 3 || version.some((part) => !Number.isInteger(part) || part < 0) || !fetchedAt) return null;
      return { version, fetchedAt };
    } catch {
      return null;
    }
  }

  #writeVersionCache(version) {
    try {
      const target = this.#versionCachePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version, fetchedAt: Date.now() }));
      fs.renameSync(tmp, target);
    } catch (error) {
      // A fresh connection is more important than a performance cache.
      this.logger.warn(`could not cache WhatsApp web version: ${error.message}`);
    }
  }

  async #version() {
    const cached = this.#readVersionCache();
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && age >= 0 && age < VERSION_CACHE_MS) {
      this.logger.info(`wa web version ${cached.version.join('.')} (cached)`);
      return cached.version;
    }

    const controller = new AbortController();
    let timer;
    try {
      timer = setTimeout(() => controller.abort(), VERSION_TIMEOUT_MS);
      const version = await fetchBaileysVersionFromGitHub({ signal: controller.signal });
      this.#writeVersionCache(version);
      this.logger.info(`wa web version ${version.join('.')} (GitHub API)`);
      return version;
    } catch (error) {
      if (cached) {
        this.logger.warn(`could not refresh WhatsApp web version; using cached version`);
        return cached.version;
      }
      this.logger.warn(`could not fetch WhatsApp web version; using library default`);
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
  #scheduleReconnect(reason, { source = 'transport-close', immediate = false } = {}) {
    if (this.stopped || this.halted || this.reconnectTimer) return;
    const ticket = ++this.retryTicket;
    this.attempt++;
    const delay = immediate ? 0 : backoffDelay(this.attempt);
    const reconnectLog =
      delay >= 60_000 && this.attempt >= 6 ? this.logger.warn.bind(this.logger) : this.logger.info.bind(this.logger);
    reconnectLog(
      `reconnecting source=${source} attempt=${this.attempt} in=${Math.round(delay / 1000)}s${reason ? ` reason=${reason}` : ''}`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.halted || ticket !== this.retryTicket) return;
      this.connect().catch((err) => {
        if (this.stopped || this.halted || ticket !== this.retryTicket) return;
        this.logger.error(`connect-failure attempt=${this.attempt}: ${err.message}`);
        this.#setState('closed');
        if (err.fatal) this.#markTerminal('connect-failure', 'fatal');
        else this.#scheduleReconnect('connect failed', { source: 'connect-failure' });
      });
    }, delay);
  }

  /** Abandon a genuinely stalled attempt and schedule a paced replacement. */
  forceReconnect(reason, { source = 'watchdog', immediate = false } = {}) {
    if (this.stopped || this.halted) return;
    const socket = this.socket;
    const previousGeneration = this.generation;
    this.logger.warn(`forcing reconnect source=${source} generation=${previousGeneration} reason=${reason}`);
    this.generation++;
    this.retryTicket++;
    this.#cancelStableOpen();
    this.awaitingLink = false;
    this.#setState('closed');
    // The old socket is intentionally made stale before end(). Report this
    // watchdog-originated outage once ourselves; its late close event is then
    // harmlessly ignored by the ownership guard.
    this.#emit('close', { reason: null, action: 'restart', generation: previousGeneration, source });
    if (socket) {
      this.queue?.detach?.(socket);
      this.socket = null;
      try { socket.end(new Error(reason)); } catch { /* already gone */ }
    }
    this.#scheduleReconnect(reason, { source, immediate });
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
    if (verdict.action === 'reconnect') this.forceReconnect(verdict.reason, { source: 'watchdog' });
    else this.#scheduleReconnect(verdict.reason, { source: 'watchdog' });
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

  #wire(socket, DisconnectReason, generation, saveCreds) {
    socket.ev.on('creds.update', () => {
      if (!this.#owns(socket, generation)) return;
      Promise.resolve(saveCreds?.()).catch((error) =>
        this.logger.error(`could not persist WhatsApp credentials: ${error.message}`)
      );
    });
    let pairingRequested = false;

    socket.ev.on('connection.update', async (update) => {
      if (!this.#owns(socket, generation)) return;
      this.lastFrameAt = Date.now();
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.info(`link requested generation=${generation}`);
        this.#emit('qr', qr);
        this.awaitingLink = true;
        if (shouldRequestPairingCode({
          qr,
          pairingNumber: this.config.wa.pairingNumber,
          registered: socket.authState?.creds?.registered,
          requested: pairingRequested,
        })) {
          pairingRequested = true;
          await this.#requestPairingCode(socket, generation);
          if (!this.#owns(socket, generation)) return;
        }
      }

      if (connection === 'open') {
        if (this.state === 'open') return;
        this.#setState('open');
        this.awaitingLink = false;
        this.lastFrameAt = Date.now();
        const me = normalizeJid(socket.user?.id || '');
        await preservePrimaryPhoneNotifications(socket, this.logger);
        if (!this.#owns(socket, generation) || this.state !== 'open') return;
        this.#scheduleStableOpen(socket, generation);
        this.logger.info(`connected generation=${generation}`);
        this.#emit('open', { jid: me, pushName: socket.user?.name || null, generation });
        return;
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const action = classifyDisconnect(reason, DisconnectReason);
        this.#cancelStableOpen();
        this.awaitingLink = false;
        this.#setState('closed');
        this.queue?.detach?.(socket);
        this.socket = null;
        this.logger.warn(`connection closed source=transport-close generation=${generation} code=${reason ?? 'none'} action=${action}`);
        this.#emit('close', { reason, action, generation, source: 'transport-close' });

        if (this.stopped || this.halted) return;
        if (action === 'replaced' || action === 'relogin') {
          this.#markTerminal(action, reason);
          this.#emit(action, { reason, generation });
          setTimeout(() => process.exit(EXIT_DO_NOT_RESTART), 1500);
          return;
        }
        this.#scheduleReconnect(`code ${reason ?? 'none'}`, { source: 'transport-close', immediate: action === 'restart' && reason === 515 });
      }
    });

    const forward = (event) => (payload) => {
      if (!this.#owns(socket, generation)) return;
      this.lastFrameAt = Date.now();
      this.#emit(event, payload);
    };
    socket.ev.on('messages.upsert', (payload) => {
      if (!this.#owns(socket, generation)) return;
      this.lastInboundAt = Date.now();
      forward('messages.upsert')(payload);
    });
    socket.ev.on('messages.update', forward('messages.update'));
    socket.ev.on('contacts.update', forward('contacts.update'));
    socket.ev.on('contacts.upsert', forward('contacts.upsert'));
    socket.ev.on('lid-mapping.update', forward('lid-mapping.update'));
    socket.ev.on('chats.update', forward('chats.update'));
    socket.ev.on('chats.upsert', forward('chats.upsert'));
    socket.ev.on('messaging-history.set', forward('messaging-history.set'));
    socket.ev.on('presence.update', forward('presence.update'));
  }

  async #requestPairingCode(socket, generation = this.generation) {
    const number = this.config.wa.pairingNumber;
    try {
      const code = await socket.requestPairingCode(number);
      if (!this.#owns(socket, generation)) return null;
      this.logger.info(`pairing code issued privately generation=${generation}`);
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
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.retryTicket++;
    this.awaitingLink = false;
    this.#cancelStableOpen();
    clearTimeout(this.reconnectTimer);
    clearInterval(this.healthTimer);
    this.reconnectTimer = null;
    this.healthTimer = null;
    const socket = this.socket;
    this.queue?.detach?.(socket);
    this.socket = null;
    try {
      await socket?.end?.();
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
