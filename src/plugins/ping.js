/**
 * Fast, low-impact liveness response. A health command must not add two queue
 * entries (or a simulated typing delay) when the connection is already under
 * pressure, otherwise it stops being a useful diagnostic.
 */

import { formatUptime } from '../lib/format.js';

function estimatedPingMs(timestamp) {
  const sentAt = Number(timestamp) * 1_000;
  if (!Number.isFinite(sentAt) || sentAt <= 0) return null;
  // WhatsApp supplies inbound timestamps at second precision, so this is an
  // honest estimate—not a fabricated synchronous “0 ms” measurement.
  return Math.max(1, Date.now() - sentAt);
}

export default {
  name: 'ping',
  aliases: ['p', 'latency'],
  category: 'tools',
  description: 'Estimated response latency and concise runtime state',
  usage: '.ping',
  ownerOnly: false,
  cooldownMs: 1000,

  async execute(ctx) {
    const mode = String(ctx.config?.mode || 'unknown').toUpperCase();
    const commandCount = ctx.plugins?.commands?.size ?? 0;
    const uptime = formatUptime(process.uptime());
    const estimate = estimatedPingMs(ctx.msg?.timestamp);
    const ping = estimate === null ? 'estimating…' : `~${estimate.toLocaleString()} ms`;

    await ctx.reply(
      [
        `🎾 *Pong!* — ${ping}`,
        '',
        `🟢 Status: \`online\``,
        `⚙️ Mode: \`${mode}\``,
        `⏱️ Uptime: \`${uptime}\``,
        `🧩 Commands: \`${commandCount}\``,
        `💬 Chat: \`${ctx.isGroup ? 'group' : 'direct'}\``,
        `🔐 Access: \`${ctx.isOwner ? 'owner' : 'standard'}\``,
        '',
        '_Estimated from WhatsApp’s inbound timestamp._',
      ].join('\n'),
      { nexusSkipTyping: true }
    );
  },
};
