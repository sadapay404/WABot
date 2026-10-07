import { timeAgo } from '../lib/format.js';

/**
 * Full-text search over the message cache, plus forwarding anything found —
 * including messages that were deleted or set to disappear.
 */
export default {
  category: 'productivity',
  commands: [
    {
      name: 'search',
      aliases: ['find', 'q'],
      description: 'Search every cached message',
      usage: '.search <terms>',
      ownerOnly: true,
      async execute(ctx) {
        if (!ctx.text) return ctx.reply('usage: .search <terms>');

        const limit = 12;
        let rows = [];
        let mode = 'fts';

        if (ctx.db.fts) {
          try {
            // FTS5 treats bare words as an implicit AND, which is what people
            // expect from a search box.
            const q = ctx.text
              .split(/\s+/)
              .map((t) => `"${t.replace(/"/g, '')}"`)
              .join(' AND ');
            rows = ctx.db
              .prepare(
                `SELECT m.*, snippet(message_fts, 0, '[', ']', '…', 8) AS snip
                   FROM message_fts
                   JOIN message_cache m ON m.rowid = message_fts.rowid
                  WHERE message_fts MATCH ?
                  ORDER BY rank
                  LIMIT ?`
              )
              .all(q, limit);
          } catch {
            mode = 'like'; // malformed FTS query — degrade rather than fail
          }
        }

        if (!rows.length) {
          mode = 'like';
          const like = `%${ctx.text.replace(/[%_]/g, '')}%`;
          rows = ctx.db
            .prepare(
              `SELECT * FROM message_cache
                WHERE text LIKE ? ORDER BY ts DESC LIMIT ?`
            )
            .all(like, limit);
        }

        if (!rows.length) return ctx.reply(`Nothing cached matching "${ctx.text}".`);

        const lines = [`🔎 *${rows.length} result(s)* _(${mode})_`, ''];
        for (const r of rows) {
          const who = r.sender_jid ? ctx.bot?.contacts?.displayName(r.sender_jid).name : 'unknown';
          const body = (r.snip || r.text || '').replace(/\s+/g, ' ').slice(0, 110);
          const flags = [r.view_once ? '👁' : '', r.has_media ? '📎' : ''].join('');
          lines.push(`• *${who}* ${timeAgo(r.ts)} ${flags}\n  ${body}`);
        }
        await ctx.reply(lines.join('\n'));
      },
    },
    {
      name: 'forward',
      aliases: ['fwd'],
      description: 'Re-send a cached message here, even if it was deleted',
      usage: '.forward <stanzaId>',
      ownerOnly: true,
      async execute(ctx) {
        const id = ctx.args[0];
        if (!id) return ctx.reply('usage: .forward <messageId>\n(find ids with .search)');

        const row = ctx.db.prepare('SELECT * FROM message_cache WHERE id = ?').get(id);
        if (!row) return ctx.reply(`No cached message with id \`${id}\`.`);

        const who = row.sender_jid ? ctx.bot?.contacts?.displayName(row.sender_jid).name : 'unknown';
        const body = row.text || `(${row.kind} — no text)`;
        const note = row.view_once ? ' · was view-once' : '';

        await ctx.reply(`↪️ *From ${who}*${note}\n\n${body}`);

        ctx.bot?.audit?.record({
          action: 'forward',
          actorJid: ctx.sender,
          plugin: 'forward',
          targetJid: ctx.jid,
          detail: `stanza ${id}`,
        });
      },
    },
  ],
};
