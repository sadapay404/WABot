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
      ? 'Overdue — 60-second timer grace; stale sends require owner review'
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
      description: 'Show pending sends or decide how to recover missed schedules',
      usage: '.agenda [today|week|missed [send|skip <id>]]',
      ownerOnly: true,
      async execute(ctx) {
        const scheduler = ctx.bot?.scheduler;
        if (!scheduler) return ctx.reply('The scheduler is not active in this mode.');

        const requested = String(ctx.args[0] || 'week').toLowerCase();
        if (requested === 'missed') {
          const action = String(ctx.args[1] || '').toLowerCase();
          if (['send', 'skip'].includes(action)) {
            const idText = String(ctx.args[2] ?? '');
            const id = /^\d+$/.test(idText) ? Number(idText) : NaN;
            if (!Number.isSafeInteger(id) || id < 1) {
              return ctx.reply('Choose a valid job ID: `.agenda missed send <id>` or `.agenda missed skip <id>`.');
            }
            const result = await scheduler.recoverMissed(id, action, scheduler.now?.() ?? Date.now());
            if (!result.ok) {
              if (result.reason === 'delivery-failed') {
                return ctx.reply(`Could not send missed job #${id}: ${result.error}. It remains in the missed queue for another explicit decision.`);
              }
              return ctx.reply(`Job #${id} is not waiting for a missed-send decision.`);
            }
            if (action === 'send') {
              return ctx.reply([
                `*Missed job #${id} sent now by your request.*`,
                ...(result.job?.status === 'pending'
                  ? [`Next recurring send: ${formatDateTime(result.nextRunAt, ctx.config?.scheduler?.timezone || 'Asia/Karachi')}`]
                  : []),
              ].join('\n'));
            }
            return ctx.reply(result.job?.status === 'pending'
              ? `Missed occurrence #${id} skipped. The next recurring send is ${formatDateTime(result.nextRunAt, ctx.config?.scheduler?.timezone || 'Asia/Karachi')}.`
              : `Missed job #${id} skipped. It will not be sent.`);
          }

          const totalMissed = scheduler.missedCount?.() ?? scheduler.missed({ limit: 500 }).length;
          const missed = scheduler.missed({ limit: 50 });
          if (!missed.length) return ctx.reply('No missed schedules are waiting for an owner decision.');
          const timezone = ctx.config?.scheduler?.timezone || 'Asia/Karachi';
          return ctx.reply([
            `*Missed sends — ${totalMissed} awaiting your decision${totalMissed > missed.length ? ` (showing ${missed.length})` : ''}*`,
            'Nothing is sent late automatically. Choose separately for each job:',
            '',
            ...missed.flatMap((job) => [
              `#${job.id} · ${formatDateTime(job.run_at, timezone)} · ${recipientLabel(ctx.bot?.contacts, job)}`,
              `   ${String(job.text || '').slice(0, 180)}`,
              `   Send now: \.agenda missed send ${job.id} · Skip: \.agenda missed skip ${job.id}`,
            ]),
            ...(totalMissed > missed.length ? ['', `${totalMissed - missed.length} more missed schedule(s) remain; resolve these IDs first, then run \.agenda missed again.`] : []),
            '',
            'For repeating schedules, skipping advances to the next future occurrence; sending now delivers only this missed occurrence.',
          ].join('\n'));
        }
        if (!['today', 'week'].includes(requested)) {
          return ctx.reply([
            '*Agenda usage*',
            '`.agenda today` — pending sends for today.',
            '`.agenda week` — pending sends across the next 7 local calendar days.',
            '`.agenda missed` — decide send-now or skip for each overdue job.',
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
      description: 'List, edit, or cancel scheduled jobs',
      usage: '.jobs | .jobs edit <id> [recipient|text|time|all] | .jobs cancel <id>',
      ownerOnly: true,
      async execute(ctx) {
        const scheduler = ctx.bot?.scheduler;
        if (!scheduler) return ctx.reply('The scheduler is not active in this mode.');

        if (String(ctx.args[0] || '').toLowerCase() === 'edit') {
          if (!ctx.bot?.scheduleWizard) return ctx.reply('The schedule edit flow is not active in this mode.');
          if (!ctx.args[1]) return ctx.reply('Use `.jobs edit <id>` to choose a field, or `.jobs edit <id> all` to change recipient, text, and time.');
          return ctx.bot.scheduleWizard.beginEdit(ctx.args[1], ctx.args[2], ctx);
        }

        if (String(ctx.args[0] || '').toLowerCase() === 'cancel') {
          const idText = String(ctx.args[1] ?? '');
          const id = /^\d+$/.test(idText) ? Number(idText) : NaN;
          if (!Number.isSafeInteger(id) || id < 1) return ctx.reply('Use `.jobs cancel <id>` with a valid job ID.');
          return ctx.reply(
            scheduler.cancel(id) ? `🚫 Job #${id} cancelled.` : `No pending job #${id}.`
          );
        }

        const rows = scheduler.list({ status: 'pending' });
        const missedCount = scheduler.missedCount?.() || 0;
        if (!rows.length) return ctx.reply(missedCount
          ? `No pending jobs. ${missedCount} missed schedule(s) need your decision; run .agenda missed.`
          : 'No pending jobs.');

        const s = scheduler.summary();
        const timezone = ctx.config?.scheduler?.timezone || 'Asia/Karachi';
        await ctx.reply(
          [
            `⏰ *Pending jobs (${rows.length})*`,
            '',
            ...rows.map(
              (j) =>
                `\`#${j.id}\` ${formatDateTime(j.run_at, timezone)} — ${String(j.text).slice(0, 60)}`
            ),
            '',
            `_${s.done} done · ${s.cancelled} cancelled · ${s.fired} fired since start · ${missedCount} missed need a decision_`,
          ].join('\n')
        );
      },
    },
  ],
};
