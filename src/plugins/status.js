import { formatUptime, timeAgo, formatBytes } from '../lib/format.js';

export default {
  name: 'health',
  aliases: ['info', 'runtime'],
  category: 'tools',
  description: 'Runtime health: mode, uptime, sessions, queue, anti-delete',
  usage: '.health',
  ownerOnly: true,

  async execute(ctx) {
    const bot = ctx.bot || {};
    const s = bot.registry?.summary?.() || {};
    const linked = bot.registry?.list?.().find((r) => r.status === 'active');
    const q = bot.queue?.depth?.() || {};
    const ad = bot.antiDelete;

    const lines = [
      `⚙️ *Nexus-WA status*`,
      '',
      `• mode: \`${ctx.config.mode}\``,
      `• uptime: \`${formatUptime(process.uptime())}\``,
      `• memory: \`${formatBytes(process.memoryUsage().rss)}\``,
      `• node: \`${process.version}\``,
      '',
      `*Session*`,
      `• linked: \`${linked ? linked.phone_e164 || linked.jid : 'none'}\``,
      `• country: \`${linked?.country_name || 'n/a'}\``,
      `• sessions: \`${s.active ?? 0}\` active / \`${s.total ?? 0}\` total`,
      `• traffic: \`${s.messagesIn ?? 0}\` in / \`${s.messagesOut ?? 0}\` out`,
      '',
      `*Runtime*`,
      `• plugins: \`${ctx.plugins.commands.size}\``,
      `• commands: \`${bot.dispatcher?.stats?.handled ?? 0}\` handled, \`${
        bot.dispatcher?.stats?.rejected ?? 0
      }\` gated`,
      `• queue: \`${q.queued ?? 0}\` pending, \`${q.sent ?? 0}\` sent`,
      `• outbound loop breaker: \`${q.halted ? 'HALTED' : 'armed'}\`, \`${q.loopBreakerTrips ?? 0}\` trip(s)`,
      `• outbound volume warnings: \`${q.volumeAnomalyAlerts ?? 0}\``,
      `• cache: \`${bot.cache?.size?.().rows ?? 0}\` messages`,
    ];

    if (ad) {
      lines.push(
        '',
        `*Anti-delete*`,
        `• enabled: \`${ad.enabled() ? 'yes' : 'no'}\``,
        `• media forwarding: \`${ad.forwardMedia() ? 'yes' : 'no'}\``,
        `• detected: \`${ad.stats.detected}\`, resolved: \`${ad.stats.resolved}\``,
        `• unresolved: \`${ad.stats.unresolved}\`, media sent: \`${ad.stats.mediaForwarded}\``
      );
    }

    if (bot.dashboard?.url?.()) lines.push('', `• dashboard: \`${bot.dashboard.url()}\``);
    if (bot.startedAt) lines.push(`• started: \`${timeAgo(bot.startedAt)}\``);

    await ctx.reply(lines.join('\n'));
  },
};
