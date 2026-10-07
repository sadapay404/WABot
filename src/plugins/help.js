export default {
  name: 'help',
  aliases: ['h', 'commands', 'menu'],
  category: 'tools',
  description: 'List every loaded command, grouped by category',
  usage: '.help [category]',
  ownerOnly: false,

  async execute(ctx) {
    const filter = (ctx.args[0] || '').toLowerCase();
    const byCategory = ctx.plugins.listByCategory();

    const lines = [`🧩 *Nexus-WA commands*`, ''];
    let shown = 0;

    for (const [category, list] of byCategory) {
      if (filter && category !== filter) continue;
      lines.push(`*${category.toUpperCase()}*`);
      for (const p of list) {
        // Never advertise owner-only commands to someone who cannot run them.
        if (p.ownerOnly && !ctx.isOwner) continue;
        const gate = p.ownerOnly ? ' 🔒' : '';
        lines.push(`  \`${p.usage}\`${gate} — ${p.description}`);
        shown++;
      }
      lines.push('');
    }

    if (!shown) {
      return ctx.reply(
        filter
          ? `No commands in category \`${filter}\`.`
          : 'No commands are available to you.'
      );
    }

    lines.push(`_mode: ${ctx.config.mode} · prefix: "${ctx.config.prefix}"_`);
    await ctx.reply(lines.join('\n'));
  },
};
