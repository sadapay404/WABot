import { parseWhen } from '../lib/when.js';

/**
 * Notes and todos. `.todo` can carry a time, which hands delivery to the
 * scheduler rather than inventing a second timer.
 */
export default {
  category: 'productivity',
  commands: [
    {
      name: 'note',
      aliases: ['n'],
      description: 'Save a note to yourself',
      usage: '.note <text> | .note list | .note del <id>',
      ownerOnly: true,
      async execute(ctx) {
        const notes = ctx.bot?.notes;
        if (!notes) return ctx.reply('Notes are not active in this mode.');

        const sub = (ctx.args[0] || '').toLowerCase();

        if (!sub) return ctx.reply('usage: .note <text> · .note list · .note del <id>');

        if (sub === 'list') {
          const rows = notes.list({ kind: 'note' });
          if (!rows.length) return ctx.reply('No notes yet.');
          return ctx.reply(
            ['📝 *Notes*', '', ...rows.map((r) => `\`#${r.id}\` ${r.text}`)].join('\n')
          );
        }
        if (sub === 'del' || sub === 'delete' || sub === 'rm') {
          const id = Number.parseInt(ctx.args[1], 10);
          return ctx.reply(notes.remove(id) ? `🗑️ Note #${id} deleted.` : `No note #${id}.`);
        }

        const row = notes.add(ctx.text, { kind: 'note' });
        await ctx.reply(`📝 Saved as \`#${row.id}\`.`);
      },
    },
    {
      name: 'todo',
      aliases: ['task'],
      description: 'Add a task, optionally with a reminder time',
      usage: '.todo <text> [in 10m | at 8pm | tomorrow 9am]',
      ownerOnly: true,
      async execute(ctx) {
        const notes = ctx.bot?.notes;
        if (!notes) return ctx.reply('Todos are not active in this mode.');

        const sub = (ctx.args[0] || '').toLowerCase();

        if (sub === 'list') {
          const rows = notes.list({ kind: 'todo' });
          if (!rows.length) return ctx.reply('No open todos.');
          return ctx.reply(
            [
              '✅ *Open todos*',
              '',
              ...rows.map((r) => {
                const when = r.remind_at
                  ? ` _(${new Date(r.remind_at).toISOString().slice(5, 16).replace('T', ' ')})_`
                  : '';
                return `\`#${r.id}\` ${r.text}${when}`;
              }),
            ].join('\n')
          );
        }
        if (sub === 'done') {
          const id = Number.parseInt(ctx.args[1], 10);
          if (!notes.complete(id)) return ctx.reply(`No open todo #${id}.`);
          ctx.bot?.scheduler && ctx.bot.scheduler; // no-op; reminders self-clear
          return ctx.reply(`✅ Todo #${id} done.`);
        }

        // Split trailing time expression: ".todo call mom at 8pm"
        const when = findWhen(ctx.text);
        const text = when ? ctx.text.slice(0, when.start).trim() : ctx.text.trim();
        if (!text) return ctx.reply('usage: .todo <text> [in 10m | at 8pm]');

        let remindAt = null;
        let label = null;
        if (when) {
          const parsed = parseWhen(when.expr, Date.now(), ctx.config?.timezone || 'UTC');
          if (!parsed) return ctx.reply(`I could not understand the time "${when.expr}".`);
          remindAt = parsed.runAt;
          label = parsed.label;
        }

        const row = notes.add(text, { kind: 'todo', remindAt });

        // Let the scheduler deliver it, so it survives a restart.
        if (remindAt && ctx.bot?.scheduler) {
          ctx.bot.scheduler.add({
            jid: ctx.bot.selfJid || ctx.jid,
            text: `Todo #${row.id}: ${text}`,
            runAt: remindAt,
          });
        }

        await ctx.reply(
          `✅ Todo \`#${row.id}\` saved${label ? ` — remind ${label}` : ''}.`
        );
      },
    },
  ],
};

/**
 * Pull a trailing time expression off a string.
 * Kept deliberately conservative: only recognises the shapes parseWhen handles.
 * @returns {{expr:string, start:number}|null}
 */
export function findWhen(text) {
  const patterns = [
    /\b(in\s+\d+\s*[smhdw])\s*$/i,
    /\b(at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*$/i,
    /\b(tomorrow(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)\s*$/i,
    /\b((?:mon|tue|wed|thu|fri|sat|sun)(?:day|uesday|nesday|hursday|riday|urday)?(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)\s*$/i,
    /\b(every\s+(?:day|daily|\d+\s*[smhdw])(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)\s*$/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) return { expr: m[1].trim(), start: m.index };
  }
  return null;
}
