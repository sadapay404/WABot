/**
 * Nexus-WA — web dashboard.
 *
 * Zero dependencies (node:http only), so there is no web framework to keep
 * patched on a bot that is supposed to run unattended for weeks.
 *
 * Auth policy, matched to the risk of what is on screen:
 * Every mode requires DASHBOARD_TOKEN. A mutable runtime mode is not evidence
 * that the database, logs, or transport are synthetic, so an unauthenticated
 * preview could otherwise expose real state on a public PaaS URL.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { formatUptime, timeAgo, formatBytes } from '../lib/format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATUS_ICON = {
  active: '🟢',
  retired: '⚪',
  logged_out: '🔴',
  banned: '⛔',
};

/** ISO code -> emoji flag. Pure and dependency-free. */
export function flagFor(iso) {
  if (!iso || iso.length !== 2) return '🏳️';
  return String(iso)
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

/**
 * Build the whole dashboard payload. Kept separate from the HTTP layer so it
 * can be asserted on without opening a socket.
 */
export function buildState(app) {
  const {
    config, registry, contacts, cache, antiDelete, plugins, dispatcher, queue, logs,
    viewOnce, editWatch, scheduler, triggers, webhooks, notes, ai, mediaStore, presenceLog,
    groupWatch, profileWatch, safety,
  } = app;

  const sessions = (registry?.list?.() || []).map((s) => ({
    ...s,
    flag: flagFor(s.country_iso),
    statusIcon: STATUS_ICON[s.status] || '•',
    firstSeenAgo: timeAgo(s.first_seen),
    lastSeenAgo: timeAgo(s.last_seen),
  }));

  const active = sessions.find((s) => s.status === 'active') || null;

  const byCountry = new Map();
  for (const s of sessions) {
    const key = s.country_name || 'Unknown';
    const cur = byCountry.get(key) || { country: key, iso: s.country_iso, count: 0, flag: s.flag };
    cur.count++;
    byCountry.set(key, cur);
  }

  const deletions = (antiDelete?.recent?.(25) || []).map((d) => ({
    ...d,
    whenAgo: timeAgo(d.deleted_at),
  }));

  const summary = registry?.summary?.() || {};

  return {
    generatedAt: Date.now(),
    synthetic: Boolean(config.isDryRun),
    mode: config.mode,
    risk: { 0: 'none', 1: 'low', 2: 'high' }[config.risk] ?? 'unknown',
    uptimeSec: Math.round(process.uptime()),
    uptime: formatUptime(process.uptime()),
    node: process.version,
    pid: process.pid,
    memory: formatBytes(process.memoryUsage().rss),

    linked: active,
    summary,
    sessions,
    countries: [...byCountry.values()].sort((a, b) => b.count - a.count),

    contacts: {
      total: contacts?.count?.() || 0,
      named: (contacts?.named?.() || []).slice(0, 40),
    },

    deletions,
    antiDelete: antiDelete
      ? { enabled: antiDelete.enabled(), forwardMedia: antiDelete.forwardMedia(), stats: antiDelete.stats }
      : null,

    cache: cache?.size?.() || { raw: 0, rows: 0 },
    cacheStats: cache?.stats || {},

    // Everything else that acts on the owner's behalf, so the dashboard can
    // answer "is the scheduler alive? are my hooks failing?" without a shell.
    services: {
      halted: safety?.halted?.() ?? false,
      viewOnce: viewOnce
        ? { enabled: viewOnce.enabled(), stats: viewOnce.stats, recent: viewOnce.recent(12) }
        : null,
      edits: editWatch ? { enabled: editWatch.enabled(), stats: editWatch.stats, recent: editWatch.recent(10) } : null,
      scheduler: scheduler
        ? { enabled: scheduler.enabled(), tickMs: scheduler.tickMs, summary: scheduler.summary(), jobs: scheduler.list({ limit: 15 }) }
        : null,
      triggers: triggers ? { enabled: triggers.enabled(), stats: triggers.stats, rules: triggers.list() } : null,
      // Secrets are never emitted — only whether a hook exists and whether it is failing.
      webhooks: webhooks
        ? webhooks.list().map((w) => ({ ...w, secret: w.secret ? '[set]' : null }))
        : [],
      notes: notes ? { summary: notes.summary(), open: notes.list({ limit: 15 }) } : null,
      media: mediaStore?.stats?.() || { count: 0, bytes: 0 },
      ai: ai ? { provider: ai.provider, configured: ai.configured(), stats: ai.stats } : null,
      presence: presenceLog?.recent?.(10) || [],
      groups: groupWatch?.recent?.(12) || [],
      profiles: profileWatch?.changes?.(12) || [],
      // Heuristic only — WhatsApp never reports a block, so this is a score
      // over independent signals, labelled as such in the UI.
      blockedSuspects: profileWatch?.suspects?.() || [],
    },

    plugins: plugins?.list?.() || [],
    pluginFailures: plugins?.failures || [],
    dispatcher: dispatcher?.stats || { handled: 0, rejected: 0, errors: 0 },
    queue: queue?.depth?.() || {},

    logs: (logs?.tail?.(80) || []).slice().reverse(),

    telegram: { enabled: Boolean(config.telegram.enabled), ownerId: config.telegram.ownerId ? '***' : '' },
    dashboard: { url: app.dashboardUrl || null, protected: true },
  };
}

export class Dashboard {
  /**
   * @param {object} deps
   * @param {object} deps.app     everything buildState needs
   * @param {object} deps.config
   * @param {object} deps.logger
   * @param {number} [deps.port]
   */
  constructor({ app, config, logger, port = 0 }) {
    this.app = app;
    this.config = config;
    this.logger = logger.child({ scope: 'dashboard' });
    this.port = port;
    this.token = process.env.DASHBOARD_TOKEN || '';
    this.sessionToken = crypto.randomBytes(32).toString('hex');
    this.server = null;
    this.html = null;
  }

  #tokenMatches(value) {
    try {
      return Boolean(value) && crypto.timingSafeEqual(Buffer.from(String(value)), Buffer.from(this.token));
    } catch {
      return false;
    }
  }

  #authed(req) {
    if (!this.token) return false;
    const url = new URL(req.url, 'http://localhost');
    const cookie = String(req.headers.cookie || '')
      .split(/;\s*/)
      .find((part) => part.startsWith('nexus_dashboard_session='))
      ?.slice('nexus_dashboard_session='.length);
    return this.#tokenMatches(cookie) || this.#tokenMatches(req.headers['x-dashboard-token']) || this.#tokenMatches(url.searchParams.get('token'));
  }


  async listen(host = '0.0.0.0') {
    if (!this.token) {
      throw new Error('Refusing to start the dashboard without DASHBOARD_TOKEN. Runtime mode cannot prove storage is synthetic.');
    }
    this.html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');

    this.server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, host, resolve);
    });

    this.port = this.server.address().port;
    this.logger.info(`dashboard listening on http://${host}:${this.port}`);
    return this;
  }

  url() {
    // Never return/log a bearer-bearing URL. Authenticate once with a private
    // token entry and the server exchanges it for an HttpOnly local session.
    return this.port ? `http://localhost:${this.port}/` : null;
  }

  #handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthz') {
      // HTTP liveness only. It intentionally makes no WhatsApp-readiness claim.
      return this.#json(res, 200, { ok: true, service: 'dashboard' });
    }

    // A one-time query/header token is exchanged for an HttpOnly session then
    // removed from the visible URL before the app polls its API.
    if (url.pathname === '/' && this.#tokenMatches(url.searchParams.get('token'))) {
      res.writeHead(302, {
        location: '/',
        'set-cookie': `nexus_dashboard_session=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
        'cache-control': 'no-store',
      });
      return res.end();
    }
    if (!this.#authed(req)) {
      res.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end('unauthorised: authenticate with DASHBOARD_TOKEN');
    }

    if (url.pathname === '/api/state') {
      try {
        return this.#json(res, 200, buildState(this.app));
      } catch (err) {
        this.logger.error(`state build failed: ${err.message}`);
        return this.#json(res, 500, { error: err.message });
      }
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(this.html);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  #json(res, code, body) {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = null;
  }
}

export default Dashboard;
