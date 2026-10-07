/**
 * Plugin template — copy this file to build a new command.
 *
 * Drop it into src/plugins/, restart, done. Nothing else to register.
 *
 * The full `ctx` contract is documented at the top of core/dispatcher.js.
 */

import { formatUptime } from '../lib/format.js';

export default {
  name: 'ping',
  aliases: ['p', 'latency'],
  category: 'tools',
  description: 'Round-trip latency check. Safe for everyone.',
  usage: '.ping',
  ownerOnly: false,
  cooldownMs: 1000,

  /**
   * @param {object} ctx
   */
  async execute(ctx) {
    const t0 = Date.now();

    await ctx.reply('🏓 …');

    const ms = Date.now() - t0;
    const mode = ctx.config.mode.toUpperCase();
    const plugins = ctx.plugins.commands.size;
    const uptime = formatUptime(process.uptime());

    await ctx.reply(
      [
        `🏓 *Pong* — ${ms}ms`,
        ``,
        `• mode: \`${mode}\``,
        `• plugins: \`${plugins}\``,
        `• uptime: \`${uptime}\``,
        ctx.isGroup ? `• chat: \`group\`` : `• chat: \`dm\``,
        ctx.isOwner ? `• you: \`owner\`` : `• you: \`guest\``,
      ].join('\n')
    );
  },
};

