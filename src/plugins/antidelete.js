/**
 * Control the anti-delete watcher and review what it caught.
 * The watcher itself lives in core/antiDelete.js and runs on socket events;
 * this plugin is just the steering wheel.
 */
export default {
  name: 'antidelete',
  aliases: ['ad', 'deleted', 'deletes'],
  category: 'privacy',
  description: 'Toggle deletion alerts, or list what was recently deleted',
  usage: '.antidelete [on|off|media on|media off|list]',
  ownerOnly: true,

  async execute(ctx) {
    const ad = ctx.bot?.antiDelete;
    if (!ad) return ctx.reply('Anti-delete is not active in this mode.');

    const sub = (ctx.args[0] || 'list').toLowerCase();
    const sub2 = (ctx.args[1] || '').toLowerCase();

    if (sub === 'on' || sub === 'off') {
      ad.setEnabled(sub === 'on');
      return ctx.reply(`🗑️ anti-delete is now \`${ad.enabled() ? 'ON' : 'OFF'}\``);
    }
    if (sub === 'media' && (sub2 === 'on' || sub2 === 'off')) {
      ad.setForwardMedia(sub2 === 'on');
      return ctx.reply(`⤴️ media forwarding is now \`${ad.forwardMedia() ? 'ON' : 'OFF'}\``);
    }
    if (sub === 'stats') {
      return ctx.reply(`📊 \`${JSON.stringify(ad.stats, null, 2)}\``);
    }

    // default: list
    const limit = Math.min(Number.parseInt(sub, 10) || 10, 30);
    const rows = ad.recent(limit);
    if (!rows.length) {
      return ctx.reply(
        `🗑️ Nothing deleted yet.\n\nstate: \`${ad.enabled() ? 'on' : 'off'}\` · media: \`${
          ad.forwardMedia() ? 'on' : 'off'
        }\``
      );
    }

    const lines = [`🗑️ *Last ${rows.length} deletions*`, ''];
    for (const r of rows) {
      const when = new Date(r.deleted_at).toISOString().slice(5, 16).replace('T', ' ');
      const body = r.content ? `"${String(r.content).slice(0, 120)}"` : `(${r.kind})`;
      lines.push(`• \`${when}\` ${r.sender_name || r.sender_phone || 'unknown'} — ${body}`);
    }
    await ctx.reply(lines.join('\n'));
  },
};
