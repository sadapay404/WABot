/**
 * Scheduling commands. Jobs are persisted in SQLite and delivered through the
 * shared outbound queue. Only `.schedule` and `.remind` use the guided preview
 * flow; `.jobs` remains available for the existing job controls.
 */
import { formatDateTime, localDayRange } from '../lib/when.js';
import { jidToPhone } from '../core/jid.js';

function localDateKey(epoch, timeZone) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(epoch))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function localDateLabel(epoch, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(epoch));
}

function localTimeLabel(epoch, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).format(new Date(epoch)).toLowerCase();
}

function repeatLabel(job) {
  if (job.kind === 'calendar') {
    try {
      return JSON.parse(job.cron || '{}').label || 'recurring';
    } catch {
      return 'recurring';
    }
  }
  if (!job.kind.startsWith('every:')) return '';
  const interval = Number(job.kind.slice('every:'.length));
  if (!Number.isFinite(interval) || interval <= 0) return 'recurring';
  const units = [
    [24 * 60 * 60 * 1_000, 'day'],
    [60 * 60 * 1_000, 'hour'],
    [60 * 1_000, 'minute'],
  ];
  const unit = units.find(([ms]) => interval % ms === 0);
  if (!unit) return `every ${Math.round(interval / 1_000)} seconds`;
  const amount = interval / unit[0];
  return `every ${amount} ${unit[1]}${amount === 1 ? '' : 's'}`;
}

function recipientLabel(contacts, job) {
  const name = contacts?.displayName?.(job.jid)?.name;
  const phone = jidToPhone(job.jid);
  if (name) return phone && name !== `+${phone}` ? `${name} (+${phone})` : name;
  return phone ? `+${phone}` : job.jid;
}

export function formatAgenda({ jobs, timezone, now, mode, contacts }) {
  const todayKey = localDateKey(now, timezone);
  const nextDay = localDayRange(now, timezone, 1);
  const tomorrowKey = nextDay ? localDateKey(nextDay.end, timezone) : '';
  const entries = jobs
    .map((job) => ({ job, runAt: job.run_at, overdue: job.run_at < now }))
    .sort((a, b) => a.runAt - b.runAt);
  const groups = new Map();

  for (const entry of entries) {
    const key = entry.overdue ? 'overdue' : localDateKey(entry.runAt, timezone);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const lines = [
    `*Agenda — ${mode === 'today' ? 'today' : 'next 7 days'}*`,
    `Timezone: ${timezone}`,
    `Scheduled items: ${entries.length}`,
  ];
  if (!entries.length) {
    lines.push('', 'No pending sends in this period.');
    return lines.join('\n');
  }

  for (const [key, items] of groups) {
    const first = items[0];
    const heading = key === 'overdue'
      ? 'Overdue — will send when the bot is online'
      : key === todayKey
        ? `Today — ${localDateLabel(first.runAt, timezone)}`
        : key === tomorrowKey
          ? `Tomorrow — ${localDateLabel(first.runAt, timezone)}`
          : localDateLabel(first.runAt, timezone);
    lines.push('', `*${heading}*`);
    for (const { job, runAt, overdue } of items) {
      const time = formatDateTime(runAt, timezone);
      const repeat = repeatLabel(job);
      const status = overdue ? `Overdue (was due ${time})` : localTimeLabel(runAt, timezone);
      const body = String(job.text || '').replace(/\s+/g, ' ').trim();
      lines.push(`• ${status} — ${recipientLabel(contacts, job)}${repeat ? ` · ${repeat}` : ''}`);
      if (body) lines.push(`  Message: ${body.length > 110 ? `${body.slice(0, 107)}…` : body}`);
    }
  }

  if (jobs.length >= 100) lines.push('', 'Showing the first 100 pending schedules.');
  return lines.join('\n');
}

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
      name: 'agenda',
      description: 'Show pending sends due today or within the next 7 days',
      usage: '.agenda [today|week]',
      ownerOnly: true,
      async execute(ctx) {
        const scheduler = ctx.bot?.scheduler;
        if (!scheduler) return ctx.reply('The scheduler is not active in this mode.');

        const requested = String(ctx.args[0] || 'week').toLowerCase();
        if (!['today', 'week'].includes(requested)) {
          return ctx.reply([
            '*Agenda usage*',
            '`.agenda today` — pending sends for today.',
            '`.agenda week` — pending sends across the next 7 local calendar days.',
            'The default view is `week`.',
          ].join('\n'));
        }

        const timezone = ctx.config?.scheduler?.timezone || 'Asia/Karachi';
        const now = scheduler.now?.() ?? Date.now();
        const range = localDayRange(now, timezone, requested === 'today' ? 1 : 7);
        if (!range?.end) return ctx.reply('I could not calculate the agenda in the configured timezone.');
        const jobs = scheduler.agenda({ end: range.end, limit: 100 });
        return ctx.reply(formatAgenda({
          jobs,
          timezone,
          now,
          mode: requested,
          contacts: ctx.bot?.contacts,
        }));
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
