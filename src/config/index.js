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
      sessionDir: path.resolve(ROOT, process.env.WA_SESSION_DIR || './data/auth'),
      botName: process.env.WA_BOT_NAME || 'Nexus-WA',
      // 'burner' or 'primary' — recorded against the session so the dashboard
      // and /sessions can show which account is which.
      role: (process.env.WA_ROLE || 'burner').toLowerCase() === 'primary' ? 'primary' : 'burner',
      browser: [
        process.env.WA_BROWSER || 'Nexus-WA',
        process.env.WA_BROWSER_DESC || 'Nexus-WA/0.1.0',
        '1.0.0',
      ],
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
