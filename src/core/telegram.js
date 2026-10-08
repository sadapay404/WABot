/**
 * Nexus-WA — Telegram remote control panel.
 *
 * Your only window into a headless bot on a free PaaS box. Single-tenant by
 * design: `assertOwner` runs before EVERY handler and any other sender is
 * logged and dropped without a reply — no command list, no "unauthorised"
 * acknowledgement, nothing an outsider can probe.
 *
 * ⚠️ NOT RUN IN THIS SANDBOX — no bot token is available here, so polling is
 * not exercised. The pure parts (command table, formatting, owner check) are
 * unit-tested.
 */

import QRCode from 'qrcode';
import { formatUptime } from '../lib/format.js';

export class TelegramPanel {
  /**
   * @param {object} deps
   * @param {object} deps.config
   * @param {object} deps.logger
   * @param {object} deps.app  { registry, cache, antiDelete, plugins, dispatcher, logs, queue, connection, dashboard, shutdown }
   */
  constructor({ config, logger, app }) {
    this.config = config;
    this.logger = logger.child({ scope: 'telegram' });
    this.app = app;
    this.bot = null;
    this.pendingQr = null;
    this.started = false;
  }

  async start() {
    const { token, ownerId } = this.config.telegram;
    if (!token || !ownerId) {
      this.logger.warn('Telegram panel disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID unset)');
      return null;
    }

    const { Telegraf } = await import('telegraf');
    const bot = new Telegraf(token);
    this.bot = bot;

    // ── Authorisation, before anything else ────────────────────────
    bot.use(async (ctx, next) => {
      if (String(ctx.from?.id) !== String(ownerId)) {
        this.logger.warn(
          `rejected Telegram access from ${ctx.from?.id} (@${ctx.from?.username || 'n/a'})`
        );
        return; // no reply at all
      }
      try {
        await next();
      } catch (err) {
        this.logger.error(`panel command failed: ${err.message}`);
        await ctx.reply(`⚠️ ${err.message}`).catch(() => {});
      }
    });

    bot.start((ctx) => ctx.reply(this.#help()));
    bot.help((ctx) => ctx.reply(this.#help()));
    bot.command('status', (ctx) => ctx.reply(this.#status()));
    bot.command('sessions', (ctx) => ctx.reply(this.#sessions()));
    bot.command('logs', (ctx) => ctx.reply(this.#logs(ctx.message.text)));
    bot.command('deletes', (ctx) => ctx.reply(this.#deletes(ctx.message.text)));
    bot.command('plugins', (ctx) => ctx.reply(this.#plugins()));
    bot.command('qr', (ctx) => this.#sendQr(ctx));
    bot.command('mode', (ctx) => this.#mode(ctx));
    bot.command('antidelete', (ctx) => ctx.reply(this.#antiDelete(ctx.message.text)));
    bot.command('kill', async (ctx) => {
      await ctx.reply('👋 shutting down');
      this.app.shutdown?.('telegram /kill');
    });

    await bot.startPolling({ dropPendingUpdates: true });
    this.started = true;
    this.logger.info(`panel online for owner ${ownerId}`);
    return bot;
  }

  // ── Push helpers ─────────────────────────────────────────────────

  async send(text) {
    if (!this.started) return false;
    try {
      await this.bot.telegram.sendMessage(this.config.telegram.ownerId, text, {
        parse_mode: 'Markdown',
      });
      return true;
    } catch (err) {
      this.logger.error(`push failed: ${err.message}`);
      return false;
    }
  }

  async sendQr(qrString) {
    this.pendingQr = qrString;
    if (!this.started) {
      this.logger.info('no Telegram panel — print the QR in the terminal instead');
      return false;
    }
    const png = await QRCode.toBuffer(qrString, { width: 460, margin: 2 });
    await this.bot.telegram.sendPhoto(this.config.telegram.ownerId, { source: png }, {
      caption: '📷 Scan this in WhatsApp → Linked Devices. It expires in ~60s.',
    });
    return true;
  }

  async sendPairingCode(code) {
    if (!code) return false;
    const pretty = String(code).replace(/(.{4})/g, '$1 ').trim();
    await this.send(`🔑 *Pairing code*\n\n\`${pretty}\`\n\nWhatsApp → Linked Devices → Link with phone number.`);
    return true;
  }

  async sendAlert(title, body) {
    return this.send(`🚨 *${title}*\n${body || ''}`);
  }

  // ── Formatters (pure, unit-tested) ───────────────────────────────

  #help() {
    return [
      '🤖 *Nexus-WA control panel*',
      '',
      '/status — runtime, mode, counters',
      '/sessions — every number ever linked',
      '/logs [n] — last n log lines (default 40)',
      '/deletes [n] — recently deleted messages',
      '/plugins — loaded command plugins',
      '/qr — resend the current pairing QR',
      '/mode <dry-run|observe|live> — switch mode',
      '/antidelete <on|off|media on|media off>',
      '/kill — graceful shutdown',
    ].join('\n');
  }

  #status() {
    const a = this.app;
    const s = a.registry?.summary?.() || {};
    const active = a.registry?.list?.().find((r) => r.status === 'active');
    const q = a.queue?.depth?.() || {};
    return [
      `⚙️ *Nexus-WA*`,
      '',
      `• mode: \`${this.config.mode}\``,
      `• uptime: \`${formatUptime(process.uptime())}\``,
      `• linked: \`${active ? active.phone_e164 || active.jid : 'none'}\``,
      `• country: \`${active?.country_name || 'n/a'}\``,
      `• plugins: \`${a.plugins?.commands.size ?? 0}\``,
      `• sessions: \`${s.total ?? 0}\` total, \`${s.active ?? 0}\` active`,
      `• messages: \`${s.messagesIn ?? 0}\` in / \`${s.messagesOut ?? 0}\` out`,
      `• deletions caught: \`${s.deletionsSeen ?? 0}\``,
      `• queue: \`${q.queued ?? 0}\` pending, \`${q.sent ?? 0}\` sent`,
      `• outbound loop breaker: \`${q.halted ? 'HALTED' : 'armed'}\`, \`${q.loopBreakerTrips ?? 0}\` trip(s)`,
      `• dashboard: \`${a.dashboard?.url?.() || 'off'}\``,
    ].join('\n');
  }

  #sessions() {
    const rows = this.app.registry?.list?.() || [];
    if (!rows.length) return 'No sessions recorded yet.';
    const lines = rows.map((r) => {
      const flag = { active: '🟢', retired: '⚪', logged_out: '🔴', banned: '⛔' }[r.status] || '•';
      return [
        `${flag} \`${r.phone_e164 || r.jid}\``,
        `   ${r.country_name || 'unknown country'} · ${r.role}`,
        `   ${r.messages_in} in / ${r.messages_out} out · ${r.connect_count} connects`,
        `   first ${new Date(r.first_seen).toISOString().slice(0, 10)} · last ${new Date(r.last_seen || 0).toISOString().slice(0, 10)}`,
      ].join('\n');
    });
    return `📱 *Linked numbers (${rows.length})*\n\n${lines.join('\n\n')}`;
  }

  #logs(text) {
    const n = Number.parseInt(String(text).split(/\s+/)[1], 10) || 40;
    const body = this.app.logs?.text(Math.min(n, 200)) || '(logging unavailable)';
    // Telegram caps a message at 4096 chars.
    return `<pre>${body.slice(-3800)}</pre>`;
  }

  #deletes(text) {
    const n = Number.parseInt(String(text).split(/\s+/)[1], 10) || 10;
    const rows = this.app.antiDelete?.recent?.(Math.min(n, 30)) || [];
    if (!rows.length) return 'Nothing deleted since startup.';
    return [
      `🗑️ *Last ${rows.length} deletions*`,
      '',
      ...rows.map((r) => {
        const when = new Date(r.deleted_at).toISOString().slice(5, 16).replace('T', ' ');
        const body = r.content ? `"${r.content.slice(0, 80)}"` : `(${r.kind})`;
        return `• ${when} · ${r.sender_name || r.sender_phone || 'unknown'} — ${body}`;
      }),
    ].join('\n');
  }

  #plugins() {
    const rows = this.app.plugins?.list?.() || [];
    if (!rows.length) return 'No plugins loaded.';
    return [
      `🧩 *Plugins (${rows.length})*`,
      '',
      ...rows.map((p) => `\`${p.usage}\` ${p.ownerOnly ? '🔒' : ''} — ${p.description}`),
    ].join('\n');
  }

  #antiDelete(text) {
    const ad = this.app.antiDelete;
    if (!ad) return 'Anti-delete is not active in this mode.';
    const arg = String(text).split(/\s+/).slice(1).join(' ').toLowerCase();
    if (arg === 'on' || arg === 'off') ad.setEnabled(arg === 'on');
    else if (arg === 'media on') ad.setForwardMedia(true);
    else if (arg === 'media off') ad.setForwardMedia(false);
    return `🗑️ anti-delete: \`${ad.enabled() ? 'on' : 'off'}\`\n⤴️ media forwarding: \`${
      ad.forwardMedia() ? 'on' : 'off'
    }\`\n📊 ${JSON.stringify(ad.stats)}`;
  }

  async #sendQr(ctx) {
    if (!this.pendingQr) return ctx.reply('No QR pending. Restart the link to generate one.');
    const png = await QRCode.toBuffer(this.pendingQr, { width: 460, margin: 2 });
    await ctx.replyWithPhoto({ source: png });
  }

  async #mode(ctx) {
    const target = String(ctx.message.text).split(/\s+/)[1];
    const allowed = ['dry-run', 'observe', 'live'];
    if (!allowed.includes(target)) {
      return ctx.reply(`usage: /mode <${allowed.join('|')}>`);
    }
    if (target === 'live' && !this.config.safety.ownerJids.length) {
      return ctx.reply('Refusing: OWNER_JIDS is empty, so live mode would be unguarded.');
    }
    this.config.mode = target;
    this.config.isDryRun = target === 'dry-run';
    this.config.isObserve = target === 'observe';
    this.config.isLive = target === 'live';
    this.config.risk = { 'dry-run': 0, observe: 1, live: 2 }[target];
    await ctx.reply(`🔀 mode is now \`${target}\`\n(restart to change the transport)`);
  }

  async stop() {
    try {
      await this.bot?.stop?.('shutdown');
    } catch {
      /* already stopped */
    }
    this.started = false;
  }
}

export async function startTelegram(opts) {
  const panel = new TelegramPanel(opts);
  await panel.start();
  return panel;
}

export default { TelegramPanel, startTelegram };
