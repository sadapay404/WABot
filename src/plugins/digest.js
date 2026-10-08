import { timeAgo, formatBytes } from '../lib/format.js';

/**
 * Daily digest. One message that answers "what happened while I wasn't
 * looking?" — deletions, edits, view-once events, group churn, what is due.
 *
 * Scheduled delivery is a one-line job:
 *   .schedule every day 8am | /digest
 * (or just run .digest whenever you want it).
 */
export default {
  category: 'productivity',
  commands: [
    {
      name: 'digest',
      aliases: ['summary', 'briefing'],
      description: 'What happened in the last 24 hours',
      usage: '.digest [hours]',
      ownerOnly: true,
      async execute(ctx) {
        const b = ctx.bot || {};
        const hours = Math.min(Math.max(Number.parseInt(ctx.args[0], 10) || 24, 1), 168);
        const since = Date.now() - hours * 3600_000;

        const q = (sql, ...p) => {
          try {
            return ctx.db.prepare(sql).all(...p);
          } catch (err) {
            ctx.logger.warn(`digest query failed: ${err.message}`);
            return [];
          }
        };

        const deletions = q('SELECT * FROM deleted_messages WHERE deleted_at >= ? ORDER BY deleted_at DESC', since);
        const viewOnce = q('SELECT * FROM view_once WHERE captured_at >= ? ORDER BY captured_at DESC', since);
        const edits = q('SELECT * FROM message_edits WHERE edited_at >= ? ORDER BY edited_at DESC', since);
        const groupEvents = q('SELECT * FROM group_events WHERE ts >= ? ORDER BY ts DESC', since);
        const messages = q('SELECT COUNT(*) AS n FROM message_cache WHERE ts >= ?', since);
        const busiest = q(
          `SELECT chat_jid, COUNT(*) AS n FROM message_cache
            WHERE ts >= ? GROUP BY chat_jid ORDER BY n DESC LIMIT 3`,
          since
        );
        const profileChanges = q('SELECT * FROM profile_events WHERE ts >= ? ORDER BY ts DESC', since);

        const todos = b.notes?.list({ kind: 'todo' }) || [];
        const notes = b.notes?.summary() || { notes: 0, todos: 0 };
        const jobs = b.scheduler?.summary() || { pending: 0 };
        const media = b.mediaStore?.stats() || { count: 0, bytes: 0 };

        const lines = [`📊 *Digest — last ${hours}h*`, ''];

        lines.push(
          `💬 *${messages[0]?.n ?? 0}* messages cached` +
            (busiest.length
              ? `\n   busiest: ${busiest
                  .map((r) => `${b.contacts?.displayName(r.chat_jid).name || r.chat_jid} (${r.n})`)
                  .join(', ')}`
              : '')
        );

        if (deletions.length) {
          lines.push('', `🗑️ *${deletions.length} deleted*`);
          for (const d of deletions.slice(0, 6)) {
            const body = d.content ? `"${String(d.content).slice(0, 60)}"` : `(${d.kind})`;
            lines.push(`   • ${d.sender_name || 'unknown'} — ${body} · ${timeAgo(d.deleted_at)}`);
          }
        }

        if (viewOnce.length) {
          lines.push('', `👁️ *${viewOnce.length} view-once events*`);
          for (const v of viewOnce.slice(0, 4)) {
            const availability = v.media_bytes
              ? ` · ${Math.round(v.media_bytes / 1024)} KB saved`
              : ' · no media bytes';
            lines.push(
              `   • ${v.sender_name || 'unknown'} — ${v.kind}${availability} · ${timeAgo(v.captured_at)}`
            );
          }
        }

        if (edits.length) {
          lines.push('', `✏️ *${edits.length} edited*`);
          for (const e of edits.slice(0, 4)) {
            lines.push(`   • ${e.sender_name || 'unknown'} — now "${String(e.after_text || '').slice(0, 50)}"`);
          }
        }

        if (groupEvents.length) {
          const joins = groupEvents.filter((g) => g.kind === 'joined').length;
          const leaves = groupEvents.filter((g) => g.kind === 'left').length;
          lines.push('', `👥 *${groupEvents.length} group events* — ${joins} joined, ${leaves} left`);
        }

        if (profileChanges.length) {
          lines.push('', `👤 *${profileChanges.length} profile changes*`);
          for (const c of profileChanges.slice(0, 4)) {
            lines.push(
              `   • ${b.contacts?.displayName(c.jid).name || c.jid} — ${c.field} changed · ${timeAgo(c.ts)}`
            );
          }
        }

        lines.push(
          '',
          `📦 ${media.count} media archived (${formatBytes(media.bytes)})`,
          `✅ ${notes.todos} open todo(s) · 📝 ${notes.notes} note(s) · ⏰ ${jobs.pending} job(s) pending`
        );

        if (todos.length) {
          lines.push('', '*Due next:*');
          for (const t of todos.slice(0, 5)) {
            lines.push(`   • ${t.text}${t.remind_at ? ` (${timeAgo(t.remind_at)})` : ''}`);
          }
        }

        if (lines.length <= 3) lines.push('_Nothing happened. Quiet is a feature._');

        await ctx.reply(lines.join('\n'));
      },
    },
  ],
};
