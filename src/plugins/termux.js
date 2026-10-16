import { normalizeJid } from '../core/jid.js';

function isControlChat(ctx) {
  const chat = normalizeJid(ctx.jid);
  const self = normalizeJid(ctx.bot?.selfJid);
  const owners = (ctx.config?.safety?.ownerJids || []).map(normalizeJid);
  return Boolean(chat && (chat === self || owners.includes(chat)));
}

function updateStatus(status) {
  if (!status.ok) return `⚠️ ${status.reason}`;
  const lines = [
    '*Nexus-WA update check*',
    `• Branch: \`${status.branch}\``,
    `• Installed: \`${status.current}\``,
    `• GitHub: \`${status.remote}\``,
  ];
  if (status.ahead > 0) {
    lines.push(`• Local-only commits: ${status.ahead}`);
    lines.push('Automatic updates are blocked to avoid changing or merging your branch.');
  } else if (status.behind > 0) {
    lines.push(`• Updates available: ${status.behind} commit(s)`);
    lines.push(status.platform === 'kerit'
      ? 'Send `.update` to fast-forward and install dependencies, then press Restart in the Kerit panel.'
      : 'Send `.update` to fast-forward, install dependencies, and restart.');
  } else {
    lines.push('Already up to date.');
  }
  return lines.join('\n');
}

function controlFor(ctx) {
  if (!isControlChat(ctx)) {
    return { error: 'For safety, use these commands only in your private controller chat or the linked account’s “You” chat.' };
  }
  const control = ctx.bot?.hostControl || ctx.bot?.termuxControl;
  if (!control) return { error: 'Host controls are not active in this installation.' };
  return { control };
}

export default {
  category: 'admin',
  commands: [
    {
      name: 'restart',
      aliases: ['reboot'],
      description: 'Restart the Termux-managed bot, or show the safe Kerit restart path',
      usage: '.restart',
      ownerOnly: true,
      privateOnly: true,
      async execute(ctx) {
        const { control, error } = controlFor(ctx);
        if (error) return ctx.reply(error);
        if (ctx.args.length) return ctx.reply('Usage: `.restart`');

        const available = control.availability();
        if (!available.ok) return ctx.reply(`⚠️ ${available.reason}`);

        if (available.platform === 'kerit') {
          return ctx.reply('ℹ️ Kerit restart: press **Restart** in the server panel. This bot will not exit itself because a clean in-container exit can leave a Pterodactyl server stopped. Your WhatsApp session and bot data stay on the mounted storage; no re-pair is needed.');
        }

        await ctx.reply('♻️ Restarting Nexus-WA. Your WhatsApp session and bot data will be kept; no re-pair is needed.');
        const scheduled = control.scheduleRestart();
        if (!scheduled.ok) {
          return ctx.reply(`⚠️ Could not schedule the restart: ${scheduled.reason}`);
        }
      },
    },
    {
      name: 'update',
      aliases: ['upgrade'],
      description: 'Check for or safely install fast-forward host updates',
      usage: '.update [check]',
      ownerOnly: true,
      privateOnly: true,
      async execute(ctx) {
        const { control, error } = controlFor(ctx);
        if (error) return ctx.reply(error);

        const action = String(ctx.args[0] || 'apply').toLowerCase();
        if (ctx.args.length > 1 || !['apply', 'check'].includes(action)) {
          return ctx.reply('Usage: `.update check` to check GitHub, or `.update` to install a safe fast-forward update.');
        }

        if (action === 'check') {
          return ctx.reply(updateStatus(await control.check()));
        }

        const platform = control.availability()?.platform;
        await ctx.reply(platform === 'kerit'
          ? '⏳ Checking GitHub and installing a fast-forward update if available. This can take a few minutes. If it succeeds, restart once from the Kerit panel.'
          : '⏳ Checking GitHub and installing the update if available. This can take a few minutes; I will restart only after dependencies install successfully.');
        const result = await control.update();
        if (!result.ok) return ctx.reply(`⚠️ Update stopped. ${result.reason}`);
        if (!result.updated) return ctx.reply(updateStatus(result));

        if (result.restartRequired || result.platform === 'kerit') {
          return ctx.reply(`✅ Code and dependencies updated to \`${result.current}\`. Now press **Restart** in the Kerit server panel once. The bot will not stop itself, because that can leave a Pterodactyl container offline. Your WhatsApp session and data are kept; no re-pair is needed.`);
        }

        const scheduled = control.scheduleRestart();
        if (!scheduled.ok) {
          return ctx.reply(`✅ Code and dependencies updated to \`${result.current}\`, but restart could not be scheduled: ${scheduled.reason}`);
        }
        return ctx.reply(`✅ Updated to \`${result.current}\` and restarting now. Your WhatsApp session and data are kept; no re-pair is needed.`);
      },
    },
  ],
};
