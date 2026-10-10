/**
 * Guided, deterministic scheduling flow for `.schedule` and `.remind`.
 *
 * A draft is stored in SQLite under the owner JID, so an unfinished prompt
 * survives a restart. It expires 24 hours after creation, or is removed earlier
 * after confirmation or when the owner cancels it.
 */

import { formatDateTime, listCalendarOccurrences, parseClock, parseWhen } from '../lib/when.js';
import { jidToPhone, normalizeJid, phoneToJid } from './jid.js';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;
const DATE_HELP = [
  'Accepted examples:',
  '• `tomorrow at 9 am`',
  '• `in 2 days at 7:20 pm`',
  '• `on 9 September at 12:00 am`',
  '• `every 2 weeks on Monday at 9 am`',
  '• `last Friday of every month at 5 pm`',
  'Use AM/PM when entering a bare hour.',
].join('\n');
const TARGET_STOPWORDS = new Set([
  'at', 'in', 'on', 'every', 'tomorrow', 'today', 'next', 'day', 'days', 'week', 'weeks',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

function trimQuotes(value) {
  return String(value || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
}

function splitPipe(input) {
  const text = String(input || '');
  const index = text.indexOf('|');
  if (index < 0) return { left: text.trim(), message: '', hasPipe: false };
  return {
    left: text.slice(0, index).trim(),
    message: text.slice(index + 1).trim(),
    hasPipe: true,
  };
}

function dateGlueAtEnd(value) {
  const last = String(value || '').trim().toLowerCase().split(/\s+/).at(-1);
  return TARGET_STOPWORDS.has(last);
}

function splitRecipientAndWhen(left, { now, timeZone, contacts }) {
  let body = String(left || '').trim();
  if (!body) return { targetText: '', whenExpression: '' };

  const hadTo = /^to\s+/i.test(body);
  if (hadTo) body = body.replace(/^to\s+/i, '').trim();

  // A complete time phrase without a recipient is valid; the wizard will ask
  // for the destination separately.
  const wholeWhen = parseWhen(body, now, timeZone, { requireTime: true });
  if (wholeWhen && !hadTo) return { targetText: '', whenExpression: body };

  const candidates = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== ' ') continue;
    const targetText = body.slice(0, i).trim();
    const whenExpression = body.slice(i + 1).trim();
    if (!targetText || !whenExpression) continue;
    const parsed = parseWhen(whenExpression, now, timeZone, { requireTime: true });
    if (!parsed) continue;
    const target = resolveRecipient(targetText, contacts);
    candidates.push({ targetText, whenExpression, parsed, target, split: i });
  }

  if (candidates.length) {
    // Prefer a recipient that actually matches a saved name/number. This also
    // prevents the word "in" in "Sam in 2 days" from being mistaken for part
    // of the destination when parsing the time suffix.
    const resolved = candidates.filter((candidate) => candidate.target.status === 'resolved');
    if (resolved.length) {
      resolved.sort((a, b) => a.split - b.split);
      const exact = resolved.find((candidate) => candidate.target.matchType === 'exact');
      const best = exact || resolved[0];
      return { targetText: best.targetText, whenExpression: best.whenExpression };
    }

    const sensible = candidates.filter((candidate) => !dateGlueAtEnd(candidate.targetText));
    const best = (sensible.length ? sensible : candidates).sort((a, b) => a.split - b.split)[0];
    return { targetText: best.targetText, whenExpression: best.whenExpression };
  }

  // If no date/time suffix was present, `to <name>` is still a useful partial
  // request and the wizard will ask for the missing time.
  return { targetText: body, whenExpression: '' };
}

/** Parse the portion before `|` and preserve everything after it as the body. */
export function parseScheduleInput(input, { now = Date.now(), timeZone = 'Asia/Karachi', contacts = null } = {}) {
  const { left, message, hasPipe } = splitPipe(input);
  const { targetText, whenExpression } = splitRecipientAndWhen(left, { now, timeZone, contacts });
  return { targetText, whenExpression, message, hasPipe };
}

/**
 * Resolve a WhatsApp phone/JID or an address-book contact name.
 * Names are matched only against the user's saved local contact names; if a
 * partial name matches multiple contacts, the caller must ask which one.
 */
export function resolveRecipient(value, contacts = null) {
  const query = trimQuotes(value).replace(/\s+/g, ' ');
  if (!query) return { status: 'missing', query: '' };

  if (query.includes('@')) {
    const jid = normalizeJid(query);
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us') || jid.endsWith('@lid')) {
      const phone = jidToPhone(jid);
      return {
        status: 'resolved',
        jid,
        label: phone ? `+${phone}` : jid,
        matchType: 'jid',
      };
    }
    return { status: 'not-found', query };
  }

  if (/^\+?[\d\s().-]+$/.test(query)) {
    let digits = query.replace(/\D/g, '');
    // Pakistan mobile numbers are commonly typed locally as 03XXXXXXXXX.
    // Convert that form to the same country-code JID as 923XXXXXXXXX.
    if (digits.length === 11 && digits.startsWith('03')) digits = `92${digits.slice(1)}`;
    if (digits.length >= 7 && digits.length <= 15) {
      const jid = phoneToJid(digits);
      return { status: 'resolved', jid, label: `+${digits}`, matchType: 'phone' };
    }
    return { status: 'invalid-number', query };
  }

  const matches = contacts?.findByName?.(query) || [];
  if (matches.length === 1) {
    const row = matches[0];
    const exact = String(row.local_name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase() === query.toLocaleLowerCase();
    const phone = jidToPhone(row.jid);
    return {
      status: 'resolved',
      jid: normalizeJid(row.jid),
      label: row.local_name || contacts?.displayName?.(row.jid)?.name || phone || row.jid,
      matchType: exact ? 'exact' : 'partial',
    };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      query,
      matches: matches.map((row) => ({
        jid: normalizeJid(row.jid),
        label: row.local_name || contacts?.displayName?.(row.jid)?.name || row.jid,
        phone: jidToPhone(row.jid),
      })),
    };
  }
  return { status: 'not-found', query };
}

function targetPrompt(kind, state) {
  if (state.targetProblem === 'self') {
    return [
      '*Choose another recipient*',
      'A scheduled message cannot be sent to the “You” chat.',
      'Enter a different WhatsApp contact name or number.',
    ].join('\n');
  }
  if (state.targetProblem === 'group' && kind === 'edit') {
    return [
      '*Direct recipient required*',
      'Schedule edits currently accept one direct WhatsApp contact, not a group.',
      'Enter a saved contact name or phone number.',
    ].join('\n');
  }
  if (state.targetProblem === 'group' && kind === 'remind') {
    return [
      '*One recipient is required*',
      'A reminder cannot be sent to a group.',
      'Enter a saved contact name or one WhatsApp number.',
    ].join('\n');
  }
  if (state.targetProblem === 'ambiguous' && state.targetMatches?.length) {
    const options = state.targetMatches
      .slice(0, 8)
      .map((item, index) => `${index + 1}. ${item.label}${item.phone ? ` (+${item.phone})` : ''}`)
      .join('\n');
    return [
      `*Several contacts match “${state.targetQuery}”*`,
      options,
      'Reply with a number from this list, the full saved name, or a phone number.',
    ].join('\n');
  }
  if (state.targetProblem === 'invalid-number') {
    return [
      '*Recipient number not recognized*',
      'Enter a complete international number, with or without `+`, or a saved contact name.',
      'Pakistani mobile numbers in `03…` format are also accepted.',
    ].join('\n');
  }
  if (state.targetProblem === 'not-found') {
    return [
      `*Contact not found: “${state.targetQuery}”*`,
      'Enter the exact saved contact name or a complete WhatsApp number.',
      'Pakistani mobile numbers in `03…` format are accepted.',
    ].join('\n');
  }

  const lines = [
    kind === 'remind' ? '*Who should receive the reminder?*' : '*Who should receive the message?*',
    'Reply with a saved contact name or a WhatsApp number.',
    'Number formats: international number with or without `+`, or Pakistani mobile `03…` format.',
  ];
  if (kind === 'remind') lines.push('The reminder goes to that contact—not to the “You” chat or Telegram.');
  return lines.join('\n');
}

function showRecipientChoice(state, answer, contacts, kind, selfJid) {
  const trimmed = String(answer || '').trim();
  let result;
  if (state.targetProblem === 'ambiguous' && /^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    const item = state.targetMatches?.[index];
    if (item) result = { status: 'resolved', ...item, label: item.label, matchType: 'choice' };
  }
  result ||= resolveRecipient(trimmed, contacts);
  if (result.status !== 'resolved') return result;
  if ((kind === 'remind' || kind === 'edit') && normalizeJid(result.jid) === normalizeJid(selfJid)) {
    return { status: 'self', query: trimmed };
  }
  if ((kind === 'remind' || kind === 'edit') && result.jid.endsWith('@g.us')) {
    return { status: 'group', query: trimmed };
  }
  return result;
}

function nextPreviewTimes(parsed) {
  if (parsed.recurrence) {
    return listCalendarOccurrences(parsed.runAt, parsed.recurrence, 3);
  }
  if (parsed.intervalMs) {
    return [0, 1, 2].map((index) => parsed.runAt + index * parsed.intervalMs);
  }
  return [parsed.runAt];
}

function formatPreview(state, timeZone) {
  const phone = jidToPhone(state.targetJid);
  const recipient = `${state.targetLabel}${phone && !String(state.targetLabel).includes(phone) ? ` (+${phone})` : ''}`;
  const sentText = state.kind === 'remind' ? `Reminder: ${state.text}` : state.text;
  const recurring = state.parsed.kind === 'recurring';
  const title = state.kind === 'edit'
    ? `*Review changes to job #${state.jobId}*`
    : `*Review ${state.kind === 'remind' ? 'reminder' : 'scheduled message'}*`;
  const lines = [title, `Recipient: ${recipient}`];

  if (recurring) {
    lines.push(`Repeat: ${state.parsed.label}`);
    if (state.parsed.recurrence?.missingDatePolicy) {
      const policy = state.parsed.recurrence.missingDatePolicy === 'last-day'
        ? 'Use the last day of the month/year.'
        : 'Skip a month/year without that date.';
      lines.push(`Missing-date rule: ${policy}`);
    }
    lines.push('Next send times:');
    for (const [index, epoch] of nextPreviewTimes(state.parsed).entries()) {
      lines.push(`${index + 1}. ${formatDateTime(epoch, timeZone)}`);
    }
  } else {
    lines.push(`Send time: ${formatDateTime(state.parsed.runAt, timeZone)}`);
  }

  lines.push('Message:', sentText);
  lines.push('Delivery: sent only at its due time; no advance notice is sent.');
  if (state.kind === 'edit') lines.push('The existing schedule changes only after confirmation.');
  lines.push('Confirm: reply YES. Discard: reply NO or CANCEL.');
  return lines.join('\n');
}

function answerText(value) {
  return String(value || '').trim();
}

function recurrencePolicyPrompt(parsed) {
  const isLeapDay = parsed.recurrence?.type === 'yearly-date';
  const condition = isLeapDay
    ? '29 February does not occur every year.'
    : `Day ${parsed.recurrence?.day} does not occur in every month.`;
  return [
    '*Choose what happens when that date is missing*',
    condition,
    '1. Skip that month or year.',
    '2. Use the last day of that month instead.',
    'Reply 1 or 2.',
  ].join('\n');
}

function parseStoredSchedule(job) {
  if (job.kind === 'calendar') {
    let recurrence = null;
    try { recurrence = JSON.parse(job.cron || 'null'); } catch { /* shown as one-off if malformed */ }
    return {
      runAt: Number(job.run_at),
      kind: 'recurring',
      recurrence,
      intervalMs: null,
      label: recurrence?.label || 'calendar recurrence',
    };
  }
  if (String(job.kind).startsWith('every:')) {
    const intervalMs = Number.parseInt(String(job.kind).split(':')[1], 10);
    return {
      runAt: Number(job.run_at),
      kind: 'recurring',
      recurrence: null,
      intervalMs,
      label: `every ${Math.round(intervalMs / 60_000)} minute(s)`,
    };
  }
  return { runAt: Number(job.run_at), kind: 'once', recurrence: null, intervalMs: null, label: 'one time' };
}

export class ScheduleWizard {
  constructor({ db, scheduler, contacts, logger, config, audit = null, selfJid = '', now = () => Date.now() }) {
    this.db = db;
    this.scheduler = scheduler;
    this.contacts = contacts;
    this.logger = logger.child({ scope: 'schedule-flow' });
    this.config = config;
    this.audit = audit;
    this.timeZone = config?.scheduler?.timezone || 'Asia/Karachi';
    this.selfJid = normalizeJid(selfJid);
    this.now = now;
    this.expireStale();
  }

  expireStale(now = this.now()) {
    return this.db.prepare('DELETE FROM schedule_drafts WHERE expires_at <= ?').run(now).changes || 0;
  }

  getDraft(ownerJid, chatJid = null) {
    const owner = normalizeJid(ownerJid);
    const row = this.db.prepare('SELECT * FROM schedule_drafts WHERE owner_jid = ?').get(owner);
    if (!row) return null;
    if (row.expires_at <= this.now()) {
      this.deleteDraft(owner);
      return null;
    }
    if (chatJid && normalizeJid(row.chat_jid) !== normalizeJid(chatJid)) return null;
    try {
      return { ...JSON.parse(row.state_json), ownerJid: owner, chatJid: normalizeJid(row.chat_jid) };
    } catch {
      this.deleteDraft(owner);
      return null;
    }
  }

  hasPending(ownerJid, chatJid) {
    const draft = this.getDraft(ownerJid, chatJid);
    return Boolean(draft);
  }

  saveDraft(state) {
    const now = this.now();
    const ownerJid = normalizeJid(state.ownerJid);
    const chatJid = normalizeJid(state.chatJid);
    const createdAt = Number(state.createdAt) || now;
    this.db.prepare(
      `INSERT INTO schedule_drafts(owner_jid, chat_jid, state_json, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_jid) DO UPDATE SET
         chat_jid=excluded.chat_jid,
         state_json=excluded.state_json,
         expires_at=excluded.expires_at,
         created_at=excluded.created_at,
         updated_at=excluded.updated_at`
    ).run(ownerJid, chatJid, JSON.stringify(state), createdAt + DRAFT_TTL_MS, createdAt, now);
  }

  deleteDraft(ownerJid) {
    return this.db.prepare('DELETE FROM schedule_drafts WHERE owner_jid = ?').run(normalizeJid(ownerJid)).changes > 0;
  }

  async begin(kind, ctx) {
    const ownerJid = normalizeJid(ctx.sender);
    const chatJid = normalizeJid(ctx.jid);
    const input = String(ctx.text || '').trim();
    if (!ownerJid || !chatJid) return ctx.reply('I could not identify this chat or owner.');

    if (/^(?:cancel|stop)$/i.test(input)) {
      const removed = this.deleteDraft(ownerJid);
      return ctx.reply(removed ? 'Draft cancelled.' : 'There is no active scheduling draft.');
    }

    const previous = this.getDraft(ownerJid);
    this.deleteDraft(ownerJid);
    const initial = parseScheduleInput(input, {
      now: this.now(),
      timeZone: this.timeZone,
      contacts: this.contacts,
    });
    const state = {
      kind,
      ownerJid,
      chatJid,
      createdAt: this.now(),
      step: null,
      targetJid: null,
      targetLabel: null,
      targetQuery: '',
      targetProblem: null,
      targetMatches: null,
      text: initial.message || '',
      whenExpression: initial.whenExpression || '',
      whenBase: null,
      parsed: null,
    };

    if (initial.targetText) {
      const result = showRecipientChoice(
        { targetProblem: null },
        initial.targetText,
        this.contacts,
        kind,
        this.selfJid || ctx.socket?.user?.id
      );
      if (result.status === 'resolved') {
        state.targetJid = result.jid;
        state.targetLabel = result.label;
      } else {
        state.targetQuery = initial.targetText;
        state.targetProblem = result.status;
        state.targetMatches = result.matches || null;
      }
    }

    this.saveDraft(state);
    const reply = (message) =>
      ctx.reply(previous ? `Previous draft replaced.\n\n${message}` : message);
    return this.#advance(state, reply);
  }

  async beginEdit(jobId, field, ctx) {
    const idText = String(jobId ?? '');
    const id = /^\d+$/.test(idText) ? Number(idText) : NaN;
    const job = Number.isSafeInteger(id) && id > 0 ? this.scheduler.get(id) : null;
    if (!job || job.status !== 'pending') return ctx.reply(`No pending schedule #${jobId} can be edited.`);
    if (Number(job.run_at) <= this.now()) {
      return ctx.reply(`Schedule #${id} is already due. Use the agenda missed recovery command; an overdue message is never edited or sent automatically.`);
    }

    const ownerJid = normalizeJid(ctx.sender);
    const chatJid = normalizeJid(ctx.jid);
    if (!ownerJid || !chatJid) return ctx.reply('I could not identify this chat or owner.');
    this.deleteDraft(ownerJid);
    const target = resolveRecipient(job.jid, this.contacts);
    const storedTargetName = this.contacts?.displayName(job.jid)?.name || job.jid;
    const state = {
      kind: 'edit',
      jobId: id,
      ownerJid,
      chatJid,
      createdAt: this.now(),
      step: 'edit-select',
      originalRunAt: Number(job.run_at),
      targetJid: normalizeJid(job.jid),
      targetLabel: target.status === 'resolved' ? target.label : storedTargetName,
      targetQuery: '',
      targetProblem: null,
      targetMatches: null,
      text: String(job.text ?? ''),
      whenExpression: 'existing stored schedule',
      whenBase: null,
      parsed: parseStoredSchedule(job),
      editRemaining: [],
    };
    this.saveDraft(state);
    if (field) return this.#selectEditField(state, field, (message) => ctx.reply(message));
    const prompt = [
      `*Edit pending schedule #${id}*`,
      `Recipient: ${state.targetLabel}`,
      `Time: ${formatDateTime(job.run_at, this.timeZone)}`,
      `Message: ${String(job.text || '').slice(0, 180)}`,
      '',
      'Reply `recipient`, `text`, `time`, or `all`. Nothing changes until you confirm the preview with YES.',
      'Reply CANCEL to leave the schedule unchanged.',
    ].join('\n');
    return ctx.reply(prompt);
  }

  async #selectEditField(state, field, reply) {
    const choice = String(field || '').toLowerCase().trim();
    const selected = choice === 'all'
      ? 'all'
      : ['recipient', 'to'].includes(choice)
        ? 'target'
        : ['text', 'message', 'body'].includes(choice)
          ? 'message'
          : ['time', 'date', 'when'].includes(choice)
            ? 'time'
            : null;
    if (!selected) {
      state.step = 'edit-select';
      this.saveDraft(state);
      await reply('Reply `recipient`, `text`, `time`, or `all`; CANCEL leaves the existing job unchanged.');
      return true;
    }

    state.editRemaining = selected === 'all' ? ['message', 'time'] : [];
    if (selected === 'target' || selected === 'all') {
      state.step = 'target';
      state.targetProblem = null;
      state.targetQuery = '';
      this.saveDraft(state);
      await reply(`Current recipient: ${state.targetLabel}\n${targetPrompt('edit', state)}`);
      return true;
    }
    if (selected === 'message') {
      state.step = 'message';
      this.saveDraft(state);
      await reply(`Current message: ${String(state.text).slice(0, 180)}\n\nEnter the replacement message text.`);
      return true;
    }
    state.step = 'when';
    state.whenExpression = '';
    state.whenBase = null;
    state.parsed = null;
    this.saveDraft(state);
    await reply(`Current time: ${formatDateTime(state.originalRunAt, this.timeZone)}\nEnter a new future date/time:\n${DATE_HELP}`);
    return true;
  }

  async #advanceEdit(state, reply) {
    if (Array.isArray(state.editRemaining) && state.editRemaining.length) {
      const next = state.editRemaining.shift();
      state.step = next;
      this.saveDraft(state);
      if (next === 'message') {
        await reply(`Enter the replacement message text. Current: ${String(state.text).slice(0, 180)}`);
        return true;
      }
      if (next === 'time') {
        state.whenExpression = '';
        state.whenBase = null;
        state.parsed = null;
        this.saveDraft(state);
        await reply(`Enter a new future date/time.\n${DATE_HELP}`);
        return true;
      }
      return this.#selectEditField(state, next, reply);
    }
    return this.#advance(state, reply);
  }

  async handleReply({ msg, reply }) {
    const state = this.getDraft(msg.sender, msg.jid);
    if (!state) return false;

    const answer = answerText(msg.text);
    if (/^(?:cancel|stop|abort)$/i.test(answer)) {
      this.deleteDraft(state.ownerJid);
      await reply(state.kind === 'edit'
        ? 'Edit cancelled. The existing schedule is unchanged.'
        : 'Draft cancelled. Nothing was scheduled.');
      return true;
    }

    if (state.step === 'edit-select') {
      return this.#selectEditField(state, answer, reply);
    }

    if (state.step === 'recurrence-policy') {
      const choice = answer.toLowerCase().trim();
      const recurrenceDatePolicy = /^(?:1|skip|skip months?|skip missing dates?)$/.test(choice)
        ? 'skip'
        : /^(?:2|last|last day|use last day|last-day)$/.test(choice)
          ? 'last-day'
          : null;
      if (!recurrenceDatePolicy) {
        await reply(recurrencePolicyPrompt(state.parsed));
        return true;
      }

      const parsed = parseWhen(state.whenExpression, this.now(), this.timeZone, {
        requireTime: true,
        recurrenceDatePolicy,
      });
      if (!parsed || parsed.needsTime || parsed.needsDatePolicy) {
        await reply('I could not apply that rule. Reply 1 to skip missing dates or 2 to use the last day.');
        return true;
      }
      state.parsed = parsed;
      return state.kind === 'edit' ? this.#advanceEdit(state, reply) : this.#advance(state, reply);
    }

    if (state.step === 'confirm') {
      if (/^(?:yes|y|confirm)$/i.test(answer)) {
        if (!state.parsed?.runAt || state.parsed.runAt <= this.now()) {
          state.step = 'when';
          state.whenExpression = '';
          state.whenBase = null;
          state.parsed = null;
          this.saveDraft(state);
          await reply(`That send time has passed. Please enter a future date and time.\n${DATE_HELP}`);
          return true;
        }

        const sendText = state.kind === 'remind' ? `Reminder: ${state.text}` : state.text;
        try {
          if (state.kind === 'edit') {
            const updated = this.scheduler.update(state.jobId, {
              jid: state.targetJid,
              text: state.text,
              runAt: state.parsed.runAt,
              kind: state.parsed.kind,
              intervalMs: state.parsed.intervalMs,
              recurrence: state.parsed.recurrence || null,
            });
            if (!updated) {
              this.deleteDraft(state.ownerJid);
              await reply(`Schedule #${state.jobId} is no longer pending, so no edit was applied.`);
              return true;
            }
            this.deleteDraft(state.ownerJid);
            this.audit?.record?.({
              action: 'schedule-edit',
              actorJid: state.ownerJid,
              plugin: 'schedule',
              targetJid: state.targetJid,
              detail: `job #${state.jobId}: ${state.parsed.label}: ${state.text.slice(0, 80)}`,
            });
            await reply([
              `*Schedule #${updated.id} updated*`,
              `Recipient: ${state.targetLabel}`,
              `Send time: ${formatDateTime(updated.run_at, this.timeZone)}`,
              ...(state.parsed.kind === 'recurring' ? [`Repeat: ${state.parsed.label}`] : []),
              'The revised message will still be sent only at its due time.',
            ].join('\n'));
            return true;
          }

          const job = this.scheduler.add({
            jid: state.targetJid,
            text: sendText,
            runAt: state.parsed.runAt,
            kind: state.parsed.kind,
            intervalMs: state.parsed.intervalMs,
            recurrence: state.parsed.recurrence || null,
          });
          this.deleteDraft(state.ownerJid);
          this.audit?.record?.({
            action: state.kind === 'remind' ? 'remind' : 'schedule',
            actorJid: state.ownerJid,
            plugin: 'schedule',
            targetJid: state.targetJid,
            detail: `${state.parsed.label}: ${sendText.slice(0, 80)}`,
          });
          await reply([
            `*${state.kind === 'remind' ? 'Reminder' : 'Scheduled message'} saved*`,
            `Job: #${job.id}`,
            `Recipient: ${state.targetLabel}`,
            `First send: ${formatDateTime(state.parsed.runAt, this.timeZone)}`,
            ...(state.parsed.kind === 'recurring' ? [`Repeat: ${state.parsed.label}`] : []),
            'No message is sent before its scheduled time.',
          ].join('\n'));
        } catch (error) {
          this.logger.error(`could not create ${state.kind} job: ${error.message}`);
          await reply(`I could not save that schedule: ${error.message}. Your draft is still here; reply YES to retry or CANCEL to discard.`);
        }
        return true;
      }
      if (/^(?:no|n|decline)$/i.test(answer)) {
        this.deleteDraft(state.ownerJid);
        await reply(state.kind === 'edit'
          ? 'Edit discarded. The existing schedule is unchanged.'
          : 'Discarded. Nothing was scheduled.');
        return true;
      }
      await reply('Please reply YES to confirm, or NO/CANCEL to discard.');
      return true;
    }

    if (!answer) {
      await reply('Please send a non-empty answer, or CANCEL to stop this draft.');
      return true;
    }

    if (state.step === 'target') {
      const result = showRecipientChoice(state, answer, this.contacts, state.kind, this.selfJid);
      if (result.status !== 'resolved') {
        state.targetQuery = answer;
        state.targetProblem = result.status;
        state.targetMatches = result.matches || null;
        this.saveDraft(state);
        await reply(targetPrompt(state.kind, state));
        return true;
      }
      state.targetJid = result.jid;
      state.targetLabel = result.label;
      state.targetQuery = '';
      state.targetProblem = null;
      state.targetMatches = null;
      return state.kind === 'edit' ? this.#advanceEdit(state, reply) : this.#advance(state, reply);
    }

    if (state.step === 'message') {
      state.text = answer;
      return state.kind === 'edit' ? this.#advanceEdit(state, reply) : this.#advance(state, reply);
    }

    if (state.step === 'when') {
      state.whenExpression = answer;
      const parsed = parseWhen(answer, this.now(), this.timeZone, { requireTime: true });
      if (!parsed || parsed.past) {
        state.whenExpression = '';
        state.whenBase = null;
        state.parsed = null;
        state.step = 'when';
        this.saveDraft(state);
        await reply([
          parsed?.past ? '*That time has passed*' : '*Date/time not understood*',
          parsed?.past ? 'Enter a future date and time.' : `I could not parse “${answer}”. Try one of these formats:`,
          DATE_HELP,
        ].join('\n'));
        return true;
      }
      if (parsed.needsTime) {
        state.whenBase = parsed.dateExpression || answer;
        state.step = 'time';
        this.saveDraft(state);
        await reply([
          parsed.ambiguousTime ? '*Clock time is unclear*' : '*Date/repeat pattern understood*',
          'Enter an exact time, such as `7:20 pm` or `19:20`.',
        ].join('\n'));
        return true;
      }
      state.parsed = parsed;
      return state.kind === 'edit' ? this.#advanceEdit(state, reply) : this.#advance(state, reply);
    }

    if (state.step === 'time') {
      const full = parseWhen(answer, this.now(), this.timeZone, { requireTime: true });
      const clockOnly = parseClock(answer);
      const clockText = answer.replace(/^at\s+/i, '').trim();
      const expression = clockOnly
        ? state.whenBase === 'at'
          ? `at ${clockText}`
          : `${state.whenBase || ''} at ${clockText}`.trim()
        : full && !full.needsTime
          ? answer
          : `${state.whenBase || ''} at ${answer}`.trim();
      const parsed = parseWhen(expression, this.now(), this.timeZone, { requireTime: true });
      if (!parsed || parsed.needsTime || parsed.past) {
        this.saveDraft(state);
        await reply([
          '*Clock time not understood*',
          'Enter an exact time, such as `7:20 pm` or `19:20`.',
        ].join('\n'));
        return true;
      }
      state.whenExpression = expression;
      state.whenBase = null;
      state.parsed = parsed;
      return state.kind === 'edit' ? this.#advanceEdit(state, reply) : this.#advance(state, reply);
    }

    // A persisted draft may have been created by an older version. Re-evaluate
    // its fields rather than leaving the user stuck on an unknown step.
    return this.#advance(state, reply);
  }

  async #advance(state, reply) {
    if (!state.targetJid) {
      state.step = 'target';
      this.saveDraft(state);
      await reply(targetPrompt(state.kind, state));
      return true;
    }

    if (!state.text) {
      state.step = 'message';
      this.saveDraft(state);
      await reply([
        state.kind === 'remind' ? '*What should I remind them about?*' : '*What message should I send?*',
        'This exact text will be sent to the recipient at the due time.',
      ].join('\n'));
      return true;
    }

    if (!state.whenExpression) {
      state.step = 'when';
      this.saveDraft(state);
      await reply([`*When should it be sent?*`, DATE_HELP].join('\n'));
      return true;
    }

    const parsed = state.parsed || parseWhen(state.whenExpression, this.now(), this.timeZone, { requireTime: true });
    if (!parsed || parsed.past) {
      state.step = 'when';
      state.whenExpression = '';
      state.parsed = null;
      this.saveDraft(state);
      await reply([
        parsed?.past ? '*That time has passed*' : '*Date/time not understood*',
        parsed?.past ? 'Enter a future date and time.' : 'Use one of the supported formats below.',
        DATE_HELP,
      ].join('\n'));
      return true;
    }
    if (parsed.needsTime) {
      state.whenBase = parsed.dateExpression || state.whenExpression;
      state.step = 'time';
      this.saveDraft(state);
      await reply([
        parsed.ambiguousTime ? '*Clock time is unclear*' : '*Date/repeat pattern understood*',
        'Enter an exact time, such as `7:20 pm` or `19:20`.',
      ].join('\n'));
      return true;
    }

    if (parsed.needsDatePolicy) {
      state.parsed = parsed;
      state.step = 'recurrence-policy';
      this.saveDraft(state);
      await reply(recurrencePolicyPrompt(parsed));
      return true;
    }

    if (!parsed.runAt || parsed.runAt <= this.now()) {
      state.step = 'when';
      state.whenExpression = '';
      state.parsed = null;
      this.saveDraft(state);
      await reply(['*That time is not in the future*', DATE_HELP].join('\n'));
      return true;
    }

    state.parsed = parsed;
    state.step = 'confirm';
    this.saveDraft(state);
    await reply(formatPreview(state, this.timeZone));
    return true;
  }
}

export default ScheduleWizard;
