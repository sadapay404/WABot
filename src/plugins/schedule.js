import { parseWhen } from '../lib/when.js';
import { findWhen } from './notes.js';

/**
 * Scheduling. Jobs are persisted by core/scheduler.js, so they survive a
 * restart on an ephemeral host.
 */
export default {
  category: 'automation',
  commands: [
    {
      name: 'schedule',
      aliases: ['sched'],
      description: 'Send a message later, once or on a repeat',
      usage: '.schedule <when> | <message>',
      ownerOnly: true,
      async execute(ctx) {
        const scheduler = ctx.bot?.scheduler;
        if (!scheduler) return ctx.reply('The scheduler is not active in this mode.');
        if (!ctx.text.includes('|')) {
          return ctx.reply('usage: .schedule <when> | <message>\ne.g. `.schedule tomorrow 9am | standup in 5`');
        }

        const [whenPart, ...rest] = ctx.text.split('|');
        const message = rest.join('|').trim();
        if (!message) return ctx.reply('Nothing to send — put the message after the `|`.');

        const when = parseWhen(whenPart.trim());
        if (!when) return ctx.reply(`I could not understand the time "${whenPart.trim()}".`);

        const job = scheduler.add({
          jid: ctx.jid,
          text: message,
          runAt: when.runAt,
          kind: when.kind,
          intervalMs: when.intervalMs,
        });

        ctx.bot?.audit?.record({
          action: 'schedule',
          actorJid: ctx.sender,
          plugin: 'schedule',
          targetJid: ctx.jid,
          detail: `${when.label}: ${message.slice(0, 80)}`,
        });

        await ctx.reply(
          `⏰ Job \`#${job.id}\` set for *${when.label}*` +
            `\n(${new Date(when.runAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)` +
            (when.kind === 'recurring' ? '\n🔁 repeats' : '')
        );
      },
    },
    {
      name: 'remind',
      aliases: ['reminder'],
      description: 'Remind yourself about something',
      usage: '.remind <text> <when>',
      ownerOnly: true,
      async execute(ctx) {
        const scheduler = ctx.bot?.scheduler;
        if (!scheduler) return ctx.reply('The scheduler is not active in this mode.');

        // Two accepted shapes:
        //   .remind call mom at 8pm        (trailing time)
        //   .remind in 20 minutes | stretch  (pipe, time on either side)
        // The pipe form exists because a reminder's natural word order is
        // "in 20 minutes, stretch", and refusing it makes the feature look
        // broken rather than merely strict.
        let text = '';
        let whenExpr = '';

        if (ctx.text.includes('|')) {
          const [left, ...rest] = ctx.text.split('|');
          const right = rest.join('|');
          const lp = parseWhen(left.trim());
          const rp = parseWhen(right.trim());
          if (lp) {
            text = right.trim();
            whenExpr = left.trim();
          } else if (rp) {
            text = left.trim();
            whenExpr = right.trim();
          } else {
            return ctx.reply(
              'I could not find a time on either side of the `|`.\n' +
                'e.g. `.remind in 20 minutes | stretch`'
            );
          }
        } else {
          const when = findWhen(ctx.text);
          if (!when) {
            return ctx.reply(
              'usage: .remind <text> <when>\n' +
                'e.g. `.remind call mom at 8pm`\n' +
                'or   `.remind in 20 minutes | call mom`'
            );
          }
          text = ctx.text.slice(0, when.start).trim();
          whenExpr = when.expr;
        }

        if (!text) return ctx.reply('What should I remind you about?');

        const parsed = parseWhen(whenExpr);
        if (!parsed) return ctx.reply(`I could not understand the time "${whenExpr}".`);

        const job = scheduler.add({
          jid: ctx.bot?.selfJid || ctx.jid,
          text: `Reminder: ${text}`,
          runAt: parsed.runAt,
          kind: parsed.kind,
          intervalMs: parsed.intervalMs,
        });

        await ctx.reply(
          `⏰ Reminding you *${parsed.label}* — "${text}" (job \`#${job.id}\`)`
        );
      },
    },
    {
      name: 'jobs',
      aliases: ['schedules'],
      description: 'List or cancel scheduled jobs',
      usage: '.jobs | .jobs cancel <id>',
      ownerOnly: true,
      async execute(ctx) {
        const scheduler = ctx.bot?.scheduler;
        if (!scheduler) return ctx.reply('The scheduler is not active in this mode.');

        if (ctx.args[0] === 'cancel') {
          const id = Number.parseInt(ctx.args[1], 10);
          return ctx.reply(
            scheduler.cancel(id) ? `🚫 Job #${id} cancelled.` : `No pending job #${id}.`
          );
        }

        const rows = scheduler.list({ status: 'pending' });
        if (!rows.length) return ctx.reply('No pending jobs.');

        const s = scheduler.summary();
        await ctx.reply(
          [
            `⏰ *Pending jobs (${rows.length})*`,
            '',
            ...rows.map(
              (j) =>
                `\`#${j.id}\` ${new Date(j.run_at).toISOString().slice(0, 16).replace('T', ' ')} — ${String(j.text).slice(0, 60)}`
            ),
            '',
            `_${s.done} done · ${s.cancelled} cancelled · ${s.fired} fired since start_`,
          ].join('\n')
        );
      },
    },
  ],
};
