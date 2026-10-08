/**
 * Nexus-WA — configuration & constants.
 *
 * Single source of truth. Nothing else in the codebase reads process.env
 * directly; everything goes through `config`. That is what makes the
 * dry-run -> observe -> live ladder a one-line change instead of a refactor.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(ROOT, '.env') });

/** Runtime modes, ordered by how much real-world risk they carry. */
export const MODES = Object.freeze({
  /** No WhatsApp connection whatsoever. Fake socket, real plugin logic. */
  DRY_RUN: 'dry-run',
  /** Connected (burner number), inbound logged, outbound hard-blocked. */
  OBSERVE: 'observe',
  /** Full bot. */
  LIVE: 'live',
});

const RISK = { [MODES.DRY_RUN]: 0, [MODES.OBSERVE]: 1, [MODES.LIVE]: 2 };

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeMode(raw) {
  const m = String(raw || MODES.DRY_RUN).trim().toLowerCase().replace(/_/g, '-');
  if (!Object.values(MODES).includes(m)) return MODES.DRY_RUN;
  return m;
}

export function buildConfig(overrides = {}) {
  const mode = normalizeMode(overrides.mode ?? process.env.NEXUS_MODE);

  const cfg = {
    root: ROOT,
    mode,
    isDryRun: mode === MODES.DRY_RUN,
    isObserve: mode === MODES.OBSERVE,
    isLive: mode === MODES.LIVE,
    risk: RISK[mode],

    prefix: (overrides.prefix ?? process.env.NEXUS_PREFIX ?? '.').slice(0, 3),
    logLevel: process.env.LOG_LEVEL || 'info',
    timezone: process.env.TZ || 'UTC',

    wa: {
      pairingNumber: String(overrides.pairingNumber ?? process.env.WA_PAIRING_NUMBER ?? '')
        .replace(/[^\d]/g, ''),
      // Opt-in only. smb_android is needed when creating a fresh companion for
      // a WhatsApp Business account; it cannot retrofit an already linked WEB session.
      companionProfile:
        String(overrides.companionProfile ?? process.env.WA_COMPANION_PROFILE ?? 'web').trim().toLowerCase() ===
        'smb_android'
          ? 'smb_android'
          : 'web',
      sessionDir: path.resolve(ROOT, process.env.WA_SESSION_DIR || './data/auth'),
      botName: process.env.WA_BOT_NAME || 'Nexus-WA',
      // 'burner' or 'primary' — recorded against the session so the dashboard
      // and /sessions can show which account is which.
      role: (process.env.WA_ROLE || 'burner').toLowerCase() === 'primary' ? 'primary' : 'burner',
      // WhatsApp validates the platform label in the pairing-code handshake.
      // Keep this canonical; custom branding can produce a code that looks
      // valid locally but is rejected by the phone.
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
    },

    dashboard: {
      enabled: bool(process.env.DASHBOARD_ENABLED, true),
      port: int(process.env.DASHBOARD_PORT, 3000),
      host: process.env.DASHBOARD_HOST || '0.0.0.0',
      token: process.env.DASHBOARD_TOKEN || '',
      // Seed synthetic sessions/contacts so the UI can be evaluated before any
      // account is linked. Ignored outside dry-run.
      seedDemo: bool(process.env.DASHBOARD_SEED_DEMO, true),
    },

    /**
     * Remote vault — keeps a WhatsApp session alive on hosts with an ephemeral
     * filesystem (Render's free tier cannot attach a persistent disk at all).
     * The blob is AES-256-GCM encrypted locally, so the remote never sees the
     * session keys.
     *
     *   kind   github | http
     *   url    a GitHub repo URL, or any endpoint accepting PUT/GET + bearer
     *   token  GitHub fine-grained PAT (contents: read/write on one repo), or
     *          the bearer token your endpoint expects
     */
    vault: {
      kind: (process.env.REMOTE_VAULT_KIND || 'github').toLowerCase(),
      url: process.env.REMOTE_VAULT_URL || '',
      token: process.env.REMOTE_VAULT_TOKEN || '',
      passphrase: process.env.REMOTE_VAULT_PASSPHRASE || '',
      path: process.env.REMOTE_VAULT_PATH || 'nexus-backup.nwb',
      intervalMin: int(process.env.REMOTE_VAULT_INTERVAL_MIN, 30),
    },

    scheduler: {
      // Poll interval for due jobs. 15s is a good default: reminders land
      // within a few seconds of their target while barely touching the disk.
      // Lower it in tests so delivery can be observed without waiting.
      tickMs: int(process.env.SCHEDULER_TICK_MS, 15_000),
      maxPerTick: int(process.env.SCHEDULER_MAX_PER_TICK, 25),
    },

    safety: {
      ownerJids: list(process.env.OWNER_JIDS),
      rateLimitPerMin: int(process.env.RATE_LIMIT_PER_MIN, 12),
      // The window the per-minute budget is measured over. Configurable so the
      // throttling behaviour can actually be asserted on in tests.
      rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60000),
      // Halt before the Nth similar text/caption send to one destination in
      // this window. Bounds prevent accidental misconfiguration from disabling
      // the breaker or retaining an excessively long history.
      outboundLoopThreshold: Math.max(
        2,
        Math.min(25, int(process.env.OUTBOUND_LOOP_THRESHOLD, 5))
      ),
      outboundLoopWindowMs: Math.max(
        1_000,
        Math.min(3_600_000, int(process.env.OUTBOUND_LOOP_WINDOW_MS, 60_000))
      ),
      // Warn the owner when a global burst exceeds this many successful sends
      // in the window. This alerts but does not pause the queue.
      outboundVolumeLimit: Math.max(5, Math.min(1_000, int(process.env.OUTBOUND_VOLUME_LIMIT, 30))),
      outboundVolumeWindowMs: Math.max(
        1_000,
        Math.min(3_600_000, int(process.env.OUTBOUND_VOLUME_WINDOW_MS, 60_000))
      ),
      queueConcurrency: Math.max(1, int(process.env.QUEUE_CONCURRENCY, 1)),
      typingIndicator: bool(process.env.TYPING_INDICATOR, true),
      observeAllowReplyToOwner: bool(process.env.OBSERVE_ALLOW_REPLY_TO_OWNER, true),
    },

    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN || '',
      ownerId: process.env.TELEGRAM_OWNER_ID || '',
      get enabled() {
        return Boolean(cfg.telegram.token && cfg.telegram.ownerId);
      },
    },

    db: {
      path: path.resolve(ROOT, process.env.DB_PATH || './data/nexus.db'),
    },

    /**
     * Where archived media and encrypted backups go.
     *
     * These default to a path *derived from the database location* rather than
     * from the repo root. That matters in a container: the volume is mounted at
     * /data while the code lives at /app, so anchoring to the repo would write
     * archived media to the ephemeral container filesystem and silently lose it
     * on every restart — defeating the entire purpose of the volume. Setting
     * DB_PATH alone is therefore enough to relocate everything persistent.
     */
    storage: {
      mediaDir: path.resolve(
        process.env.MEDIA_DIR
          || path.join(path.dirname(path.resolve(ROOT, process.env.DB_PATH || './data/nexus.db')), 'media')
      ),
      backupDir: path.resolve(
        process.env.BACKUP_DIR
          || path.join(path.dirname(path.resolve(ROOT, process.env.DB_PATH || './data/nexus.db')), 'backups')
      ),
    },

    ai: {
      provider: (process.env.AI_PROVIDER || 'groq').toLowerCase(),
      model: process.env.AI_MODEL || '',
      maxHistory: int(process.env.AI_MAX_HISTORY, 12),
      keys: {
        groq: process.env.GROQ_API_KEY || '',
        gemini: process.env.GEMINI_API_KEY || '',
        openai: process.env.OPENAI_API_KEY || '',
      },
    },
  };

  return cfg;
}

/** Hard safety rails, evaluated at boot so misconfiguration fails fast. */
export function validateConfig(cfg) {
  const problems = [];
  const warnings = [];

  if (cfg.isLive && cfg.safety.ownerJids.length === 0) {
    problems.push(
      'NEXUS_MODE=live but OWNER_JIDS is empty — every contact could run owner commands.'
    );
  }
  if (!cfg.isDryRun && !cfg.wa.pairingNumber) {
    warnings.push('WA_PAIRING_NUMBER empty — falling back to QR code (needs a camera).');
  }
  if (!cfg.isDryRun && cfg.safety.rateLimitPerMin > 25) {
    warnings.push(
      `RATE_LIMIT_PER_MIN=${cfg.safety.rateLimitPerMin} is aggressive; <=12 is the safer default.`
    );
  }
  if (cfg.mode !== MODES.DRY_RUN && !cfg.telegram.enabled) {
    warnings.push('Telegram panel not configured — you will have no remote visibility.');
  }
  if (cfg.mode === MODES.LIVE && !cfg.telegram.enabled) {
    problems.push('Refusing NEXUS_MODE=live without a Telegram panel configured.');
  }
  if (!cfg.isDryRun && cfg.dashboard.enabled && !cfg.dashboard.token) {
    problems.push(
      'Dashboard is enabled in a connected mode without DASHBOARD_TOKEN. ' +
        'It would expose real phone numbers and contact names — set a token or ' +
        'set DASHBOARD_ENABLED=false.'
    );
  }

  return { problems, warnings };
}

export default buildConfig;
