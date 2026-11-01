/**
 * Fast, low-impact liveness response. A health command must not add two queue
 * entries (or a simulated typing delay) when the connection is already under
 * pressure, otherwise it stops being a useful diagnostic.
 */

import { formatUptime } from '../lib/format.js';

export default {
  name: 'ping',
  aliases: ['p', 'latency'],
  category: 'tools',
  description: 'Fast liveness response. Safe for everyone.',
  usage: '.ping',
  ownerOnly: false,
  cooldownMs: 1000,

  /**
   * @param {object} ctx
   */
  async execute(ctx) {
    const started = Date.now();
    const mode = ctx.config.mode.toUpperCase();
    const plugins = ctx.plugins.commands.size;
    const uptime = formatUptime(process.uptime());

    // One immediate queue entry. This is the bot's processing/queue response
    // time, not a fabricated WhatsApp network round-trip.
    await ctx.reply(
      [
        `🏓 *Pong* — ${Date.now() - started}ms`,
        ``,
        `• mode: \`${mode}\``,
        `• plugins: \`${plugins}\``,
        `• uptime: \`${uptime}\``,
        ctx.isGroup ? `• chat: \`group\`` : `• chat: \`dm\``,
        ctx.isOwner ? `• you: \`owner\`` : `• you: \`guest\``,
      ].join('\n'),
      { nexusSkipTyping: true }
    );
  },
};
