/**
 * Scheduling commands. Jobs are persisted in SQLite and delivered through the
 * shared outbound queue. Only `.schedule` and `.remind` use the guided preview
 * flow; `.jobs` remains available for the existing job controls.
 */
export default {
  category: 'automation',
  commands: [
    {
      name: 'schedule',
      aliases: ['sched'],
      description: 'Send a message to a contact later, once or on a repeat',
      usage: '.schedule to Sam on 9 September at 12:00 am | Happy birthday!',
      ownerOnly: true,
      async execute(ctx) {
        if (!ctx.bot?.scheduler || !ctx.bot?.scheduleWizard) {
          return ctx.reply('The scheduler is not active in this mode.');
        }
        return ctx.bot.scheduleWizard.begin('schedule', ctx);
      },
    },
    {
      name: 'remind',
      aliases: ['reminder'],
      description: 'Send a reminder to a WhatsApp contact or number',
      usage: '.remind to 923001234567 in 2 days at 7:20 pm | Take your medicine',
      ownerOnly: true,
      async execute(ctx) {
        if (!ctx.bot?.scheduler || !ctx.bot?.scheduleWizard) {
          return ctx.reply('The scheduler is not active in this mode.');
        }
        return ctx.bot.scheduleWizard.begin('remind', ctx);
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
