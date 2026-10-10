/** Scheduling parser, guided flow, recipient safety and self-chat dispatch tests. */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildConfig, validateConfig } from '../src/config/index.js';
import { getMemoryDb } from '../src/database/index.js';
import { ContactStore } from '../src/core/contactStore.js';
import { createLogger } from '../src/core/logger.js';
import { Dispatcher } from '../src/core/dispatcher.js';
import { MockWhatsAppSocket } from '../src/core/mockSocket.js';
import { normalize } from '../src/core/message.js';
import { OutboundQueue } from '../src/core/outboundQueue.js';
import { PluginLoader } from '../src/core/pluginLoader.js';
import { ScheduleWizard, parseScheduleInput, resolveRecipient } from '../src/core/scheduleWizard.js';
import { Scheduler } from '../src/core/scheduler.js';
import {
  firstCalendarOccurrence,
  formatDateTime,
  listCalendarOccurrences,
  localDayRange,
  localDateRange,
  nextCalendarOccurrence,
  parseClock,
  parseWhen,
} from '../src/lib/when.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const quiet = createLogger('fatal');
const OWNER = '15550009999@s.whatsapp.net';
const SAM = '923001234567@s.whatsapp.net';
const SPARE = '923001234568@s.whatsapp.net';
const NOW = Date.UTC(2026, 0, 1, 19, 0, 0); // 00:00 on Jan 2 in Asia/Karachi
const ZONE = 'Asia/Karachi';

function fakeSocket() {
  const sent = [];
  return {
    sent,
    user: { id: OWNER },
    async sendMessage(jid, content = {}) {
      sent.push({ jid, content, text: content.text || content.caption || '' });
      return { key: { id: `SENT-${sent.length}`, remoteJid: jid, fromMe: true } };
    },
  };
}

async function wizardRig({ now = () => NOW, names = [{ jid: SAM, name: 'Sam' }] } = {}) {
  const db = await getMemoryDb();
  const contacts = new ContactStore(db, quiet);
  for (const contact of names) contacts.upsert({ id: contact.jid, name: contact.name });
  const socket = fakeSocket();
  const scheduler = new Scheduler({ db, socket, logger: quiet });
  scheduler.now = now;
  const config = buildConfig({ mode: 'dry-run' });
  config.scheduler.timezone = ZONE;
  const wizard = new ScheduleWizard({
    db,
    scheduler,
    contacts,
    logger: quiet,
    config,
    selfJid: OWNER,
    now,
  });
  const replies = [];
  const reply = async (jid, text) => {
    replies.push({ jid, text });
    await socket.sendMessage(jid, { text });
  };
  const command = (text, kind = 'schedule') => ({
    sender: OWNER,
    jid: OWNER,
    text,
    socket,
    reply: (body) => reply(OWNER, body),
  });
  const answer = (text) => wizard.handleReply({
    msg: { sender: OWNER, jid: OWNER, text },
    reply: (body) => reply(OWNER, body),
  });
  return { db, contacts, socket, scheduler, config, wizard, replies, reply, command, answer };
}

test('schedule timezone defaults to Asia/Karachi and rejects invalid IANA names', () => {
  const config = buildConfig({ mode: 'dry-run' });
  assert.equal(config.scheduler.timezone, ZONE);
  const invalid = buildConfig({ mode: 'dry-run', schedulerTimezone: 'Mars/Bannu' });
  assert.ok(validateConfig(invalid).problems.some((problem) => /SCHEDULE_TIMEZONE/.test(problem)));
});

test('when parser uses Asia/Karachi local calendar days and clock times', () => {
  const parsed = parseWhen('in 2 days at 7:20 pm', NOW, ZONE);
  assert.equal(parsed.kind, 'once');
  assert.equal(parsed.runAt, Date.UTC(2026, 0, 4, 14, 20));
  assert.equal(formatDateTime(parsed.runAt, ZONE), 'Sunday, 4 January 2026 at 7:20 pm (Asia/Karachi)');

  const date = parseWhen('on 9 September at 12:00 am', NOW, ZONE);
  assert.equal(date.runAt, Date.UTC(2026, 8, 8, 19, 0));
});

test('when parser asks for a clock instead of defaulting or guessing', () => {
  const missing = parseWhen('in 2 days', NOW, ZONE, { requireTime: true });
  assert.equal(missing.needsTime, true);
  assert.deepEqual(missing.dateParts, { year: 2026, month: 1, day: 4 });

  const bareHour = parseWhen('at 8', NOW, ZONE, { requireTime: true });
  assert.equal(bareHour.needsTime, true);
  assert.equal(bareHour.ambiguousTime, true);
  assert.equal(parseWhen('sometime later', NOW, ZONE), null);
  assert.deepEqual(parseClock('12:00 am'), { h: 0, m: 0 });
  assert.deepEqual(parseClock('7:20 pm'), { h: 19, m: 20 });
  assert.equal(parseClock('8'), null, 'a bare hour has no AM/PM and must not be guessed');
});

test('when parser supports daily and weekly recurring local times', () => {
  const daily = parseWhen('every day at 8 pm', NOW, ZONE);
  assert.equal(daily.kind, 'recurring');
  assert.equal(daily.intervalMs, 24 * 60 * 60 * 1_000);
  assert.equal(daily.runAt, Date.UTC(2026, 0, 2, 15, 0));

  const weekly = parseWhen('every Friday at 8 pm', NOW, ZONE);
  assert.equal(weekly.kind, 'recurring');
  assert.equal(weekly.intervalMs, 7 * 24 * 60 * 60 * 1_000);
  assert.equal(weekly.runAt, Date.UTC(2026, 0, 2, 15, 0));

  const incomplete = parseWhen('every day', NOW, ZONE, { requireTime: true });
  assert.equal(incomplete.needsTime, true);
  assert.equal(incomplete.dateExpression, 'every day');
});

test('calendar recurrence supports biweekly, monthly weekday/day, and annual rules', () => {
  const biweekly = parseWhen('every 2 weeks on Monday at 9 am', NOW, ZONE, { requireTime: true });
  assert.equal(biweekly.kind, 'recurring');
  assert.equal(biweekly.recurrence.type, 'weekly');
  assert.equal(biweekly.runAt, Date.UTC(2026, 0, 5, 4));
  assert.deepEqual(listCalendarOccurrences(biweekly.runAt, biweekly.recurrence, 3), [
    Date.UTC(2026, 0, 5, 4),
    Date.UTC(2026, 0, 19, 4),
    Date.UTC(2026, 1, 2, 4),
  ]);

  const monthly = parseWhen('the 15th of every month at 9 am', NOW, ZONE, { requireTime: true });
  assert.equal(monthly.runAt, Date.UTC(2026, 0, 15, 4));
  assert.deepEqual(listCalendarOccurrences(monthly.runAt, monthly.recurrence, 2), [
    Date.UTC(2026, 0, 15, 4),
    Date.UTC(2026, 1, 15, 4),
  ]);

  const lastFriday = parseWhen('last Friday of every month at 5 pm', NOW, ZONE, { requireTime: true });
  assert.equal(lastFriday.runAt, Date.UTC(2026, 0, 30, 12));
  assert.equal(parseWhen('annually on 9 September at 9 am', NOW, ZONE, { requireTime: true }).label,
    'Every year on 9 September at 9:00 am');
});

test('monthly and leap-day recurrences require an explicit missing-date rule', () => {
  const monthly = parseWhen('every month on the 31st at 9 am', NOW, ZONE, { requireTime: true });
  assert.equal(monthly.needsDatePolicy, true);
  assert.equal(monthly.recurrence.needsDatePolicy, true);

  const skip = parseWhen('every month on the 31st at 9 am', NOW, ZONE, {
    requireTime: true,
    recurrenceDatePolicy: 'skip',
  });
  assert.deepEqual(listCalendarOccurrences(skip.runAt, skip.recurrence, 3), [
    Date.UTC(2026, 0, 31, 4),
    Date.UTC(2026, 2, 31, 4),
    Date.UTC(2026, 4, 31, 4),
  ]);

  const lastDay = parseWhen('every month on the 31st at 9 am', NOW, ZONE, {
    requireTime: true,
    recurrenceDatePolicy: 'last-day',
  });
  assert.deepEqual(listCalendarOccurrences(lastDay.runAt, lastDay.recurrence, 3), [
    Date.UTC(2026, 0, 31, 4),
    Date.UTC(2026, 1, 28, 4),
    Date.UTC(2026, 2, 31, 4),
  ]);

  const leapSkip = parseWhen('annually on 29 February at 9 am', NOW, ZONE, {
    requireTime: true,
    recurrenceDatePolicy: 'skip',
  });
  assert.equal(leapSkip.runAt, Date.UTC(2028, 1, 29, 4));
  const leapLastDay = parseWhen('annually on 29 February at 9 am', NOW, ZONE, {
    requireTime: true,
    recurrenceDatePolicy: 'last-day',
  });
  assert.equal(leapLastDay.runAt, Date.UTC(2026, 1, 28, 4));
});

test('explicit date bounds use local midnight and reject invalid calendar dates', () => {
  assert.deepEqual(localDateRange('2026-01-02', ZONE), {
    start: Date.UTC(2026, 0, 1, 19),
    end: Date.UTC(2026, 0, 2, 19),
  });
  assert.equal(localDateRange('2026-02-29', ZONE), null);
  assert.equal(localDateRange('not-a-date', ZONE), null);
});

test('calendar recurrence and agenda bounds preserve local wall-clock time', () => {
  const range = localDayRange(NOW, ZONE, 1);
  assert.deepEqual(range, {
    start: Date.UTC(2026, 0, 1, 19),
    end: Date.UTC(2026, 0, 2, 19),
  });

  const recurrence = {
    type: 'weekly', intervalWeeks: 2, weekday: 1, hour: 9, minute: 0, timeZone: 'America/New_York',
  };
  const first = firstCalendarOccurrence(Date.UTC(2026, 2, 1, 14), recurrence);
  const next = nextCalendarOccurrence(first, recurrence);
  const localClock = (epoch) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hourCycle: 'h12',
  }).format(new Date(epoch));
  assert.match(localClock(first), /9:00/);
  assert.match(localClock(next), /9:00/);
});

test('schedule input separates named/number recipients, date phrase and pipe body', async () => {
  const { contacts } = await wizardRig();
  const parsed = parseScheduleInput(
    'to Sam in 2 days at 7:20 pm | Happy birthday! | see you soon',
    { now: NOW, timeZone: ZONE, contacts }
  );
  assert.equal(parsed.targetText, 'Sam');
  assert.equal(parsed.whenExpression, 'in 2 days at 7:20 pm');
  assert.equal(parsed.message, 'Happy birthday! | see you soon');

  const numeric = resolveRecipient('923001234568', contacts);
  assert.equal(numeric.status, 'resolved');
  assert.equal(numeric.jid, SPARE);
  assert.equal(resolveRecipient('+92 300 123 4568', contacts).jid, SPARE);
  assert.equal(resolveRecipient('03001234568', contacts).jid, SPARE, 'Pakistani local mobile format should normalize to +92');
});

test('schedule requires preview confirmation and sends only at the due time', async () => {
  const rig = await wizardRig();
  await rig.wizard.begin('schedule', rig.command('to Sam in 2 days at 7:20 pm | Happy birthday, Sam!'));

  const preview = rig.replies.at(-1).text;
  assert.match(preview, /Recipient: Sam/);
  assert.match(preview, /Sunday, 4 January 2026 at 7:20 pm \(Asia\/Karachi\)/);
  assert.match(preview, /Happy birthday, Sam!/);
  assert.match(preview, /no advance notice/i);
  assert.match(preview, /Confirm: reply YES/);
  assert.equal(rig.scheduler.pending().length, 0, 'preview must not persist a job');
  assert.ok(rig.socket.sent.every((message) => message.jid === OWNER), 'preview is private to the command chat');

  await rig.answer('YES');
  const job = rig.scheduler.pending()[0];
  assert.ok(job);
  assert.equal(job.jid, SAM);
  assert.equal(job.text, 'Happy birthday, Sam!');
  assert.equal(job.run_at, Date.UTC(2026, 0, 4, 14, 20));
  assert.ok(rig.socket.sent.every((message) => message.jid === OWNER), 'recipient has not been contacted yet');

  await rig.scheduler.tick(job.run_at - 1);
  assert.equal(rig.socket.sent.some((message) => message.jid === SAM), false);
  await rig.scheduler.tick(job.run_at);
  assert.ok(rig.socket.sent.some((message) => message.jid === SAM && message.text === 'Happy birthday, Sam!'));
});

test('wizard asks how to handle missing monthly dates and persists calendar recurrence', async () => {
  const rig = await wizardRig();
  await rig.wizard.begin(
    'schedule',
    rig.command('to Sam every month on the 31st at 9 am | Month-end update')
  );
  assert.match(rig.replies.at(-1).text, /Choose what happens when that date is missing/);
  assert.match(rig.replies.at(-1).text, /1\. Skip/);
  assert.match(rig.replies.at(-1).text, /2\. Use the last day/);
  assert.equal(rig.scheduler.pending().length, 0);

  await rig.answer('2');
  const preview = rig.replies.at(-1).text;
  assert.match(preview, /Missing-date rule: Use the last day/);
  assert.match(preview, /Saturday, 31 January 2026 at 9:00 am/);
  assert.match(preview, /Saturday, 28 February 2026 at 9:00 am/);
  assert.match(preview, /Confirm: reply YES/);

  await rig.answer('YES');
  const job = rig.scheduler.pending()[0];
  assert.equal(job.kind, 'calendar');
  assert.equal(JSON.parse(job.cron).missingDatePolicy, 'last-day');
  assert.equal(job.run_at, Date.UTC(2026, 0, 31, 4));

  await rig.scheduler.tick(job.run_at);
  const rearmed = rig.scheduler.get(job.id);
  assert.equal(rearmed.status, 'pending');
  assert.equal(rearmed.run_at, Date.UTC(2026, 1, 28, 4));
  assert.ok(rig.socket.sent.some((message) => message.jid === SAM && message.text === 'Month-end update'));
});

test('guided schedule asks for missing fields in order and saves after YES', async () => {
  const rig = await wizardRig();
  await rig.wizard.begin('schedule', rig.command(''));
  assert.match(rig.replies.at(-1).text, /Who should receive/);

  await rig.answer('Sam');
  assert.match(rig.replies.at(-1).text, /What message should I send/);
  await rig.answer('Bring the folder');
  assert.match(rig.replies.at(-1).text, /When should it be sent/);
  await rig.answer('in 2 days');
  assert.match(rig.replies.at(-1).text, /Enter an exact time/);
  await rig.answer('7:20 pm');
  assert.match(rig.replies.at(-1).text, /Review scheduled message/);
  assert.equal(rig.scheduler.pending().length, 0);
  await rig.answer('yes');
  assert.equal(rig.scheduler.pending().length, 1);
  assert.equal(rig.scheduler.pending()[0].text, 'Bring the folder');
});

test('remind requires a per-request recipient and never targets the self chat', async () => {
  const rig = await wizardRig();
  await rig.wizard.begin(
    'remind',
    rig.command('to 923001234568 in 2 days at 7:20 pm | Take your medicine', 'remind')
  );
  assert.match(rig.replies.at(-1).text, /Recipient: \+923001234568/);
  assert.equal(rig.scheduler.pending().length, 0);
  await rig.answer('yes');

  const job = rig.scheduler.pending()[0];
  assert.equal(job.jid, SPARE);
  assert.notEqual(job.jid, OWNER);
  assert.equal(job.text, 'Reminder: Take your medicine');
  assert.ok(rig.socket.sent.every((message) => message.jid !== SPARE), 'no reminder is sent before its due time');

  const selfReminder = await wizardRig();
  await selfReminder.wizard.begin(
    'remind',
    selfReminder.command('to 15550009999 in 2 days at 7:20 pm | Do the thing', 'remind')
  );
  assert.match(selfReminder.replies.at(-1).text, /cannot be sent to the “You” chat/);
  assert.equal(selfReminder.scheduler.pending().length, 0);
});

test('ambiguous saved contact names cause a choice instead of picking one', async () => {
  const rig = await wizardRig({ names: [
    { jid: '923001234567@s.whatsapp.net', name: 'Sam One' },
    { jid: '923001234569@s.whatsapp.net', name: 'Sam Two' },
  ] });
  await rig.wizard.begin('schedule', rig.command('to Sam in 2 days at 7:20 pm | Hello'));
  assert.match(rig.replies.at(-1).text, /Several contacts match/);
  assert.match(rig.replies.at(-1).text, /Sam One/);
  assert.match(rig.replies.at(-1).text, /Sam Two/);
  assert.equal(rig.scheduler.pending().length, 0);
});

test('unfinished drafts survive restart and expire after 24 hours', async () => {
  let now = NOW;
  const rig = await wizardRig({ now: () => now });
  await rig.wizard.begin('remind', rig.command(''));
  assert.equal(rig.wizard.hasPending(OWNER, OWNER), true);

  const restarted = new ScheduleWizard({
    db: rig.db,
    scheduler: rig.scheduler,
    contacts: rig.contacts,
    logger: quiet,
    config: rig.config,
    selfJid: OWNER,
    now: () => now,
  });
  assert.equal(restarted.hasPending(OWNER, OWNER), true, 'a new wizard instance sees the stored draft');
  now += 24 * 60 * 60 * 1_000 + 1;
  assert.equal(restarted.hasPending(OWNER, OWNER), false);
});

test('self-chat permits owner scheduling only, accepts guided replies, and ignores echoes/history', async () => {
  const db = await getMemoryDb();
  const contacts = new ContactStore(db, quiet);
  contacts.upsert({ id: SAM, name: 'Sam' });
  const config = buildConfig({ mode: 'dry-run' });
  config.safety.ownerJids = [OWNER];
  config.safety.typingIndicator = false;
  const plugins = new PluginLoader({ dir: path.join(ROOT, 'src', 'plugins'), logger: quiet });
  await plugins.loadAll();
  const socket = new MockWhatsAppSocket({ logger: quiet, ownerJid: OWNER, botJid: OWNER });
  const queue = new OutboundQueue(socket, config, quiet);
  queue.attach();
  const scheduler = new Scheduler({ db, socket, logger: quiet });
  scheduler.now = () => NOW;
  scheduler.add({ jid: SAM, text: 'Late item', runAt: NOW - 60 * 1_000 });
  scheduler.add({ jid: SAM, text: 'Prepare the report', runAt: NOW + 60 * 60 * 1_000 });
  const wizard = new ScheduleWizard({
    db, scheduler, contacts, logger: quiet, config, selfJid: OWNER, now: () => NOW,
  });
  const dispatcher = new Dispatcher({ plugins, config, logger: quiet, db });
  dispatcher.bot = { scheduler, scheduleWizard: wizard, contacts, selfJid: OWNER };
  dispatcher.trackSocket(socket);
  socket.on('messages.upsert', async ({ messages = [], type }) => {
    for (const raw of messages) {
      const msg = normalize(raw);
      msg.upsertType = type;
      await dispatcher.handle(socket, msg);
    }
  });

  await socket.inject('.agenda today', { jid: OWNER, from: OWNER, fromMe: true });
  assert.match(socket.outbox.at(-1).text, /Agenda — today/);
  assert.match(socket.outbox.at(-1).text, /Timezone: Asia\/Karachi/);
  assert.match(socket.outbox.at(-1).text, /Sam/);
  assert.match(socket.outbox.at(-1).text, /923001234567/);
  assert.match(socket.outbox.at(-1).text, /Prepare the report/);
  assert.ok(socket.outbox.at(-1).text.indexOf('Overdue') < socket.outbox.at(-1).text.indexOf('Today'));
  assert.equal(scheduler.pending().length, 2, 'agenda must not alter or send scheduled jobs');

  await socket.inject('.schedule', { jid: OWNER, from: OWNER, fromMe: true });
  assert.match(socket.outbox.at(-1).text, /Who should receive/);
  assert.equal(wizard.hasPending(OWNER, OWNER), true);

  const promptEcho = socket.outbox.at(-1).text;
  const countBeforeEcho = socket.outbox.length;
  await socket.inject(promptEcho, { jid: OWNER, from: OWNER, fromMe: true });
  assert.equal(socket.outbox.length, countBeforeEcho, 'the bot must ignore its own prompt echo');
  assert.equal(wizard.getDraft(OWNER, OWNER).step, 'target', 'an echo must not consume the guided answer');

  await socket.inject('.jobs', { jid: OWNER, from: OWNER, fromMe: true });
  assert.match(socket.outbox.at(-1).text, /Pending jobs|No pending jobs|Scheduled jobs/);
  assert.equal(wizard.getDraft(OWNER, OWNER).step, 'target', 'owner commands do not consume wizard replies');
  const countBeforeExternalEcho = socket.outbox.length;
  await socket.inject('.schedule', { jid: SAM, from: OWNER, fromMe: true });
  assert.equal(socket.outbox.length, countBeforeExternalEcho, 'outgoing messages to other chats remain ignored');

  const replay = normalize({
    key: { remoteJid: OWNER, fromMe: true, id: 'HISTORY-OLD' },
    messageTimestamp: Math.floor(NOW / 1_000),
    message: { conversation: '.schedule' },
  });
  replay.upsertType = 'append';
  await dispatcher.handle(socket, replay);
  assert.equal(wizard.getDraft(OWNER, OWNER).step, 'target', 'old history must not re-run a command');

  await socket.inject('Sam', { jid: OWNER, from: OWNER, fromMe: true });
  assert.match(socket.outbox.at(-1).text, /What message should I send/);
  assert.equal(wizard.getDraft(OWNER, OWNER).step, 'message');

  config.safety.ownerJids = [SPARE];
  const beforeUnauthorized = socket.outbox.length;
  await socket.inject('.remind', { jid: OWNER, from: OWNER, fromMe: true });
  assert.equal(socket.outbox.length, beforeUnauthorized, 'self-chat scheduling still requires the configured owner');
});
