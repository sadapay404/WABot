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
  description: 'Confirm bot liveness and show concise runtime state',
  usage: '.ping',
  ownerOnly: false,
  cooldownMs: 1000,

  /**
   * WhatsApp does not expose a reliable end-to-end round-trip acknowledgement
   * for this command. Reporting the time needed to construct a JavaScript
   * string as “latency” created the meaningless 0 ms value, so this is an
   * honest liveness response rather than a fabricated network measurement.
   */
  async execute(ctx) {
    const mode = String(ctx.config?.mode || 'unknown').toUpperCase();
    const commandCount = ctx.plugins?.commands?.size ?? 0;
    const uptime = formatUptime(process.uptime());

    await ctx.reply(
      [
        '🏓 *Nexus is online*',
        '',
        `• mode: \`${mode}\``,
        `• process uptime: \`${uptime}\``,
        `• commands loaded: \`${commandCount}\``,
        `• chat: \`${ctx.isGroup ? 'group' : 'direct'}\``,
        `• access: \`${ctx.isOwner ? 'owner' : 'standard'}\``,
        '',
        '_This confirms the bot received your command. WhatsApp does not provide a trustworthy round-trip ms value here._',
      ].join('\n'),
      { nexusSkipTyping: true }
    );
  },
};
