import { timeAgo } from '../lib/format.js';
import { flagFor } from '../web/dashboard.js';

/**
 * Every WhatsApp number this install has ever been linked to.
 * Useful when you are moving from a burner to your real number and want to
 * confirm which account is currently live.
 */
export default {
  name: 'sessions',
  aliases: ['numbers', 'linked', 'accounts'],
  category: 'admin',
  description: 'List every number ever linked, with country and traffic',
  usage: '.sessions',
  ownerOnly: true,

  async execute(ctx) {
    const registry = ctx.bot?.registry;
    if (!registry) return ctx.reply('Session registry is unavailable.');

    const rows = registry.list();
    if (!rows.length) return ctx.reply('No sessions recorded yet.');

    const icon = { active: '🟢', retired: '⚪', logged_out: '🔴', banned: '⛔' };
    const lines = [`📱 *Linked numbers (${rows.length})*`, ''];

    for (const r of rows) {
      lines.push(
        `${icon[r.status] || '•'} \`${r.phone_e164 || r.jid}\``,
        `   ${flagFor(r.country_iso)} ${r.country_name || 'unknown country'} · role: \`${r.role}\` · \`${r.status}\``,
        `   ${r.messages_in} in / ${r.messages_out} out · ${r.connect_count} connects · ${r.deletions_seen} deletions`,
        `   first ${timeAgo(r.first_seen)} · last ${timeAgo(r.last_seen)}`,
        ''
      );
    }

    const s = registry.summary();
    lines.push(
      `_${s.active} active · ${s.retired} retired · ${s.loggedOut} logged out · ${s.banned} banned_`
    );
    await ctx.reply(lines.join('\n'));
  },
};
