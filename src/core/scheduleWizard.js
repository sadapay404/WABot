/**
 * Guided, deterministic scheduling flow for `.schedule` and `.remind`.
 *
 * A draft is stored in SQLite under the owner JID, so an unfinished prompt
 * survives a restart. It expires 24 hours after creation, or is removed earlier
 * after confirmation or when the owner cancels it.
 */

import { formatDateTime, parseClock, parseWhen } from '../lib/when.js';
import { jidToPhone, normalizeJid, phoneToJid } from './jid.js';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;
const DATE_HELP =
  'Examples: `in 2 days at 7:20 pm`, `tomorrow at 9 am`, ' +
  '`on 9 September at 12:00 am`, or `every Friday at 8 pm`. ' +
  'Use AM/PM for a bare hour.';
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
    return 'A reminder cannot go to the “You” chat. Enter a different WhatsApp contact or number (for example, your spare number).';
  }
  if (state.targetProblem === 'group' && kind === 'remind') {
    return 'A reminder needs one receiving contact or phone number, not a group. Enter the contact name or number.';
  }
  if (state.targetProblem === 'ambiguous' && state.targetMatches?.length) {
    const options = state.targetMatches
      .slice(0, 8)
      .map((item, index) => `${index + 1}. ${item.label}${item.phone ? ` (+${item.phone})` : ''}`)
      .join('\n');
    return `I found more than one contact for “${state.targetQuery}”. Reply with the full saved name or a number:\n${options}`;
  }
  if (state.targetProblem === 'invalid-number') {
    return 'That number does not look complete. Enter a full WhatsApp number with country code (the + sign is optional; Pakistani 03… mobile numbers also work), or a saved contact name.';
  }
  if (state.targetProblem === 'not-found') {
    return `I could not find “${state.targetQuery}” in your saved contacts. Reply with the exact saved contact name, a full WhatsApp number with country code, or a Pakistani local 03… mobile number (the + is optional).`;
  }
  return kind === 'remind'
    ? 'Who should receive this reminder? Reply with a saved contact name or a full WhatsApp number (country code included; + is optional; Pakistani 03… mobile format also works). It will be sent there, not to the “You” chat or Telegram.'
    : 'Who should receive the scheduled message? Reply with a saved contact name or a full WhatsApp number (country code included; + is optional; Pakistani 03… mobile format also works).';
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
  if (kind === 'remind' && normalizeJid(result.jid) === normalizeJid(selfJid)) {
    return { status: 'self', query: trimmed };
  }
  if (kind === 'remind' && result.jid.endsWith('@g.us')) {
    return { status: 'group', query: trimmed };
  }
  return result;
}

function formatPreview(state, timeZone) {
  const phone = jidToPhone(state.targetJid);
  const recipient = `${state.targetLabel}${phone && !String(state.targetLabel).includes(phone) ? ` (+${phone})` : ''}`;
  const sentText = state.kind === 'remind' ? `Reminder: ${state.text}` : state.text;
  const lines = [
    `Please confirm this ${state.kind === 'remind' ? 'reminder' : 'scheduled message'}:`,
    `To: ${recipient}`,
    `Send time: ${formatDateTime(state.parsed.runAt, timeZone)}`,
  ];
  if (state.parsed.kind === 'recurring') lines.push(`Repeats: ${state.parsed.label}`);
  lines.push(`Message: ${sentText}`);
  lines.push('Only this message will be sent at the due time; no advance notice will be sent.');
  lines.push('Reply YES to confirm, or NO/CANCEL to discard.');
  return lines.join('\n');
}

function answerText(value) {
  return String(value || '').trim();
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
    const reply = (message) => ctx.reply(message);
    if (previous) {
      await reply('I replaced the older unfinished scheduling draft with this one.');
    }
    return this.#advance(state, reply);
  }

  async handleReply({ msg, reply }) {
    const state = this.getDraft(msg.sender, msg.jid);
    if (!state) return false;

    const answer = answerText(msg.text);
    if (/^(?:cancel|stop|abort)$/i.test(answer)) {
      this.deleteDraft(state.ownerJid);
      await reply('Draft cancelled. Nothing was scheduled.');
      return true;
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
          const job = this.scheduler.add({
            jid: state.targetJid,
            text: sendText,
            runAt: state.parsed.runAt,
            kind: state.parsed.kind,
            intervalMs: state.parsed.intervalMs,
          });
          this.deleteDraft(state.ownerJid);
          this.audit?.record?.({
            action: state.kind === 'remind' ? 'remind' : 'schedule',
            actorJid: state.ownerJid,
            plugin: 'schedule',
            targetJid: state.targetJid,
            detail: `${state.parsed.label}: ${sendText.slice(0, 80)}`,
          });
          await reply(
            `${state.kind === 'remind' ? '🔔 Reminder' : '⏰ Scheduled message'} ` +
            `confirmed as job #${job.id}. Nothing is sent to the recipient before its due time.`
          );
        } catch (error) {
          this.logger.error(`could not create ${state.kind} job: ${error.message}`);
          await reply(`I could not save that schedule: ${error.message}. Your draft is still here; reply YES to retry or CANCEL to discard.`);
        }
        return true;
      }
      if (/^(?:no|n|decline)$/i.test(answer)) {
        this.deleteDraft(state.ownerJid);
        await reply('Discarded. Nothing was scheduled.');
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
      return this.#advance(state, reply);
    }

    if (state.step === 'message') {
      state.text = answer;
      return this.#advance(state, reply);
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
        await reply(
          parsed?.past
            ? `That date/time is already in the past. Please give me a future one.\n${DATE_HELP}`
            : `I could not understand “${answer}”. Please enter a supported date/time.\n${DATE_HELP}`
        );
        return true;
      }
      if (parsed.needsTime) {
        state.whenBase = parsed.dateExpression || answer;
        state.step = 'time';
        this.saveDraft(state);
        await reply(
          `${parsed.ambiguousTime ? 'That clock time is ambiguous or invalid.' : 'I have the date/repeat pattern.'} What time should I use? Include AM/PM, for example 7:20 pm.`
        );
        return true;
      }
      state.parsed = parsed;
      return this.#advance(state, reply);
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
        await reply(
          `I still could not resolve that clock time. Use an exact time such as 7:20 pm or 19:20.\n${DATE_HELP}`
        );
        return true;
      }
      state.whenExpression = expression;
      state.whenBase = null;
      state.parsed = parsed;
      return this.#advance(state, reply);
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
      await reply(
        state.kind === 'remind'
          ? 'What should I remind them about? This exact text will be sent at the due time.'
          : 'What message should I send? This exact text will be sent at the due time.'
      );
      return true;
    }

    if (!state.whenExpression) {
      state.step = 'when';
      this.saveDraft(state);
      await reply(`When should I send it?\n${DATE_HELP}`);
      return true;
    }

    const parsed = state.parsed || parseWhen(state.whenExpression, this.now(), this.timeZone, { requireTime: true });
    if (!parsed || parsed.past) {
      state.step = 'when';
      state.whenExpression = '';
      state.parsed = null;
      this.saveDraft(state);
      await reply(
        parsed?.past
          ? `That date/time is already in the past. Please enter a future one.\n${DATE_HELP}`
          : `I could not understand that date/time.\n${DATE_HELP}`
      );
      return true;
    }
    if (parsed.needsTime) {
      state.whenBase = parsed.dateExpression || state.whenExpression;
      state.step = 'time';
      this.saveDraft(state);
      await reply(
        `${parsed.ambiguousTime ? 'That clock time is ambiguous or invalid.' : 'I have the date/repeat pattern.'} What time should I use? Include AM/PM, for example 7:20 pm.`
      );
      return true;
    }

    if (!parsed.runAt || parsed.runAt <= this.now()) {
      state.step = 'when';
      state.whenExpression = '';
      state.parsed = null;
      this.saveDraft(state);
      await reply(`That date/time is not in the future. Please enter a future one.\n${DATE_HELP}`);
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
