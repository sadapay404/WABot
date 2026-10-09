/**
 * Deterministic date/time parser for reminders and schedules.
 *
 * No system prompt, network service, or AI is involved. Supported shapes are
 * intentionally explicit; unsupported input returns null. Schedule/remind
 * callers set `{ requireTime: true }`, which returns `needsTime` for missing
 * or ambiguous clocks. The default retains legacy `.todo` shorthand behavior.
 *
 * Calendar phrases are interpreted in an IANA timezone, defaulting to the
 * user's selected Asia/Karachi timezone. In particular, "in 2 days at 7pm"
 * means 7pm on the local calendar date two days from now, not 48 hours from
 * the current instant.
 */

const DAY_MS = 86_400_000;
const UNIT_MS = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
  w: 7 * DAY_MS,
  wk: 7 * DAY_MS,
  wks: 7 * DAY_MS,
  week: 7 * DAY_MS,
  weeks: 7 * DAY_MS,
};

const WEEKDAYS = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const formatterCache = new Map();

function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
    );
  }
  return formatterCache.get(timeZone);
}

function zonedParts(epochMs, timeZone) {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function validCalendarDate({ year, month, day }) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function addCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Convert a wall-clock date/time in `timeZone` to an epoch, or null on a DST gap. */
function localToEpoch(parts, timeZone) {
  const local = {
    ...parts,
    hour: parts.hour ?? parts.h ?? 0,
    minute: parts.minute ?? parts.m ?? 0,
  };
  const desired = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  let guess = desired;

  // Iteratively account for the IANA zone's offset. This also works for zones
  // whose offset is not a whole number of hours. Asia/Karachi has no DST, while
  // the round-trip check keeps other configured zones from silently normalising
  // a nonexistent wall-clock time.
  for (let attempt = 0; attempt < 6; attempt++) {
    const seen = zonedParts(guess, timeZone);
    const seenAsUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      seen.second,
      0
    );
    const delta = desired - seenAsUtc;
    if (delta === 0) {
      return guess;
    }
    guess += delta;
  }

  const check = zonedParts(guess, timeZone);
  return check.year === local.year &&
    check.month === local.month &&
    check.day === local.day &&
    check.hour === local.hour &&
    check.minute === local.minute
    ? guess
    : null;
}

/** Parse a clearly specified wall-clock time. Bare hours are intentionally ambiguous. */
export function parseClock(input) {
  const text = String(input || '').trim().toLowerCase().replace(/^at\s+/, '');
  if (text === 'midnight') return { h: 0, m: 0 };
  if (text === 'noon') return { h: 12, m: 0 };

  const meridiem = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (meridiem) {
    let h = Number(meridiem[1]);
    const m = Number(meridiem[2] || 0);
    if (h < 1 || h > 12 || m > 59) return null;
    if (meridiem[3] === 'pm' && h < 12) h += 12;
    if (meridiem[3] === 'am' && h === 12) h = 0;
    return { h, m };
  }

  // A colon makes a clock unambiguous and is therefore accepted as 24-hour time.
  const twentyFourHour = text.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHour) {
    const h = Number(twentyFourHour[1]);
    const m = Number(twentyFourHour[2]);
    if (h > 23 || m > 59) return null;
    return { h, m };
  }
  return null;
}

function looksLikeBareHour(text) {
  return /^\d{1,2}$/.test(String(text || '').trim());
}

// Compatibility for existing non-schedule callers such as `.todo`. The new
// scheduling wizard sets requireTime=true and never uses this implicit AM/PM.
function parseLegacyClock(text) {
  const value = String(text || '').trim().toLowerCase().replace(/^at\s+/, '');
  const explicit = parseClock(value);
  if (explicit) return explicit;
  if (!looksLikeBareHour(value)) return null;
  const h = Number(value);
  return h <= 23 ? { h, m: 0 } : null;
}

function clockLabel(clock) {
  const h = clock.h % 12 || 12;
  const meridiem = clock.h < 12 ? 'am' : 'pm';
  return `${h}:${String(clock.m).padStart(2, '0')} ${meridiem}`;
}

function clean(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[，,]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
}

function normalizeUnit(unit) {
  return String(unit || '').toLowerCase().replace(/s$/, (s, offset, full) => {
    // Keep irregular abbreviations; only remove the plural suffix when it
    // actually creates a known singular unit.
    const candidate = full.slice(0, offset);
    return UNIT_MS[candidate] ? '' : s;
  });
}

function durationMs(amount, unit) {
  const normalized = normalizeUnit(unit);
  return Number(amount) * (UNIT_MS[normalized] || 0);
}

function dateOnly(dateParts, timeZone, extra = {}) {
  return {
    kind: 'once',
    needsTime: true,
    dateParts,
    dateExpression: extra.dateExpression || null,
    ambiguousTime: Boolean(extra.ambiguousTime),
    implicitDate: Boolean(extra.implicitDate),
    past: Boolean(extra.past),
    timeZone,
    label: extra.label || 'date selected; time needed',
  };
}

function weekdayIndex(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/** Recognise today/tomorrow, weekday names, ISO dates, and English month dates. */
function parseCalendarDate(text, nowParts, now, timeZone, clock = null) {
  let raw = clean(text).replace(/^on\s+/, '').replace(/^the\s+/, '').trim();
  if (!raw) return null;

  if (raw === 'today') {
    return { dateParts: { year: nowParts.year, month: nowParts.month, day: nowParts.day }, dateExpression: 'today' };
  }
  if (raw === 'tomorrow' || raw === 'tmr') {
    return { dateParts: addCalendarDays(nowParts, 1), dateExpression: 'tomorrow' };
  }
  if (raw === 'day after tomorrow') {
    return { dateParts: addCalendarDays(nowParts, 2), dateExpression: 'day after tomorrow' };
  }

  const weekdayMatch = raw.match(/^(next\s+)?([a-z]+)$/);
  if (weekdayMatch && WEEKDAYS[weekdayMatch[2]] !== undefined) {
    const wanted = WEEKDAYS[weekdayMatch[2]];
    let delta = (wanted - weekdayIndex(nowParts) + 7) % 7;
    if (weekdayMatch[1] || delta === 0) delta += 7;
    let dateParts = addCalendarDays(nowParts, delta);
    if (!weekdayMatch[1] && delta === 7 && clock) {
      // A weekday typed on the same weekday means the next future occurrence;
      // an upcoming time today is still useful, rather than always a week away.
      const todayAtTime = localToEpoch({ ...nowParts, ...clock }, timeZone);
      if (wanted === weekdayIndex(nowParts) && todayAtTime > now) dateParts = nowParts;
    }
    return { dateParts, dateExpression: `${weekdayMatch[1] ? 'next ' : ''}${weekdayMatch[2]}` };
  }

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const dateParts = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
    if (!validCalendarDate(dateParts)) return null;
    return { dateParts, dateExpression: raw, explicitYear: true };
  }

  raw = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const dayFirst = raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/);
  const monthFirst = raw.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
  const match = dayFirst || monthFirst;
  if (!match) return null;

  const monthName = dayFirst ? match[2] : match[1];
  const month = MONTHS[monthName];
  if (!month) return null;
  const day = Number(dayFirst ? match[1] : match[2]);
  const yearText = dayFirst ? match[3] : match[3];
  const explicitYear = Boolean(yearText);
  let year = explicitYear ? Number(yearText) : nowParts.year;
  let dateParts = { year, month, day };
  if (!validCalendarDate(dateParts)) {
    if (explicitYear) return null;
    // A February 29 without a year means the next actual leap-day occurrence.
    while (year < nowParts.year + 8 && !validCalendarDate({ year, month, day })) year++;
    dateParts = { year, month, day };
    if (!validCalendarDate(dateParts)) return null;
  }

  if (!explicitYear) {
    const candidate = clock ? localToEpoch({ ...dateParts, ...clock }, timeZone) : null;
    const isPastCalendarDate =
      dateParts.year < nowParts.year ||
      (dateParts.year === nowParts.year && dateParts.month < nowParts.month) ||
      (dateParts.year === nowParts.year && dateParts.month === nowParts.month && dateParts.day < nowParts.day);
    if (isPastCalendarDate || (candidate !== null && candidate <= now)) {
      year++;
      dateParts = { year, month, day };
      if (!validCalendarDate(dateParts)) {
        while (year < nowParts.year + 9 && !validCalendarDate(dateParts)) {
          year++;
          dateParts = { year, month, day };
        }
      }
    }
  }

  if (!validCalendarDate(dateParts)) return null;
  const dateExpression = dayFirst
    ? `${day} ${monthName}${explicitYear ? ` ${year}` : ''}`
    : `${monthName} ${day}${explicitYear ? ` ${year}` : ''}`;
  return { dateParts, dateExpression, explicitYear };
}

function makeOneTime(parsedDate, clock, now, timeZone, { explicitDate = true } = {}) {
  if (!clock) return dateOnly(parsedDate.dateParts, timeZone, { dateExpression: parsedDate.dateExpression });

  const runAt = localToEpoch({ ...parsedDate.dateParts, ...clock }, timeZone);
  if (runAt === null) {
    return dateOnly(parsedDate.dateParts, timeZone, {
      dateExpression: parsedDate.dateExpression,
      ambiguousTime: true,
      label: 'time is not valid in this timezone',
    });
  }

  const past = explicitDate && runAt <= now;
  return {
    kind: 'once',
    runAt,
    label: `${parsedDate.dateExpression || 'today'} at ${clockLabel(clock)}`,
    timeZone,
    ...(past ? { past: true } : {}),
  };
}

function parseRecurring(raw, now, nowParts, timeZone, requireTime) {
  const match = raw.match(/^every\s+(.+)$/);
  if (!match) return null;
  const rest = match[1].trim();

  // Exact intervals such as every 30m and every 2 hours do not need a clock.
  const interval = rest.match(/^(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)$/);
  if (interval) {
    const intervalMs = durationMs(interval[1], interval[2]);
    if (!intervalMs) return null;
    const unitLabel = interval[2];
    return {
      kind: 'recurring',
      runAt: now + intervalMs,
      intervalMs,
      label: `every ${interval[1]} ${unitLabel}`,
      timeZone,
    };
  }

  let frequency;
  let cadence;
  let intervalMs;
  let weekday = null;
  let timeText = '';

  const dayFrequency = rest.match(/^(?:day|daily)(?:\s+(?:at\s+)?(.+))?$/);
  const countFrequency = rest.match(/^(\d+)\s+(days?|weeks?)(?:\s+(?:at\s+)?(.+))?$/);
  const weekdayFrequency = rest.match(/^(?:(?:week|weekly)\s+(?:on\s+)?([a-z]+)|([a-z]+))(?:\s+(?:at\s+)?(.+))?$/);
  const weekFrequency = rest.match(/^(?:week|weekly)(?:\s+(?:at\s+)?(.+))?$/);

  if (dayFrequency) {
    frequency = 'day';
    cadence = 'every day';
    intervalMs = DAY_MS;
    timeText = dayFrequency[1] || '';
  } else if (countFrequency) {
    const amount = Number(countFrequency[1]);
    if (!amount) return null;
    const unit = countFrequency[2].startsWith('week') ? 7 : 1;
    frequency = 'days';
    const unitName = unit === 7 ? (amount === 1 ? 'week' : 'weeks') : (amount === 1 ? 'day' : 'days');
    cadence = `every ${amount} ${unitName}`;
    intervalMs = amount * unit * DAY_MS;
    timeText = countFrequency[3] || '';
  } else if (weekdayFrequency && WEEKDAYS[weekdayFrequency[1] || weekdayFrequency[2]] !== undefined) {
    frequency = 'week';
    weekday = WEEKDAYS[weekdayFrequency[1] || weekdayFrequency[2]];
    const weekdayName = Object.entries(WEEKDAYS).find(([name, day]) => name.length > 3 && day === weekday)?.[0];
    cadence = `every ${weekdayName}`;
    intervalMs = 7 * DAY_MS;
    timeText = weekdayFrequency[3] || '';
  } else if (weekFrequency) {
    frequency = 'week';
    cadence = 'every week';
    intervalMs = 7 * DAY_MS;
    timeText = weekFrequency[1] || '';
  } else {
    return null;
  }

  const clockText = timeText.replace(/^at\s+/, '').trim();
  let clock = clockText ? parseClock(clockText) : null;
  const hasAmbiguousClock = Boolean(clockText && !clock && looksLikeBareHour(clockText));
  if (clockText && !clock && !hasAmbiguousClock) return null;
  if (!clock && !requireTime) clock = hasAmbiguousClock ? parseLegacyClock(clockText) : { h: 9, m: 0 };
  if (!clock) {
    return {
      kind: 'recurring',
      needsTime: true,
      recurrence: { intervalMs, weekday, frequency },
      dateExpression: cadence,
      ambiguousTime: hasAmbiguousClock,
      label: `${cadence}; time needed`,
      timeZone,
    };
  }

  let dateParts = { year: nowParts.year, month: nowParts.month, day: nowParts.day };
  if (weekday !== null) {
    const delta = (weekday - weekdayIndex(nowParts) + 7) % 7;
    dateParts = addCalendarDays(nowParts, delta);
  }
  let runAt = localToEpoch({ ...dateParts, ...clock }, timeZone);
  if (runAt === null) return null;
  if (runAt <= now) {
    const daysToAdd = weekday !== null ? 7 : Math.max(1, Math.round(intervalMs / DAY_MS));
    dateParts = addCalendarDays(dateParts, daysToAdd);
    runAt = localToEpoch({ ...dateParts, ...clock }, timeZone);
    if (runAt === null) return null;
  }

  const label = `${cadence} at ${clockLabel(clock)}`;
  return { kind: 'recurring', runAt, intervalMs, label, timeZone };
}

function parseRelativeCalendar(raw, now, nowParts, timeZone, requireTime) {
  const match = raw.match(
    /^(?:in\s+)?(\d+)\s+(days?|weeks?)(?:\s+(?:later|from\s+now))?(?:\s+(?:at\s+)?(.+))?$/
  );
  if (!match) return null;
  const amount = Number(match[1]);
  if (!amount) return null;
  const days = amount * (match[2].startsWith('week') ? 7 : 1);
  const dateParts = addCalendarDays(nowParts, days);
  const dateExpression = `${match[1]} ${match[2]}`;
  const timeText = (match[3] || '').trim();
  let clock = timeText ? parseClock(timeText) : null;
  const ambiguousTime = Boolean(timeText && !clock && looksLikeBareHour(timeText));
  if (timeText && !clock && !ambiguousTime) return null;
  if (!clock && !requireTime && ambiguousTime) clock = parseLegacyClock(timeText);
  if (!clock && !timeText && !requireTime) {
    const runAt = now + days * DAY_MS;
    return { kind: 'once', runAt, label: `in ${amount} ${match[2]}`, timeZone };
  }
  if (!clock) return dateOnly(dateParts, timeZone, { dateExpression, ambiguousTime });

  const runAt = localToEpoch({ ...dateParts, ...clock }, timeZone);
  if (runAt === null) return dateOnly(dateParts, timeZone, { dateExpression, ambiguousTime: true });
  return {
    kind: 'once',
    runAt,
    label: `in ${amount} ${match[2]} at ${clockLabel(clock)}`,
    timeZone,
  };
}

/**
 * Parse a date/time phrase. Returns null when no supported pattern matches.
 * `needsTime` means a calendar date (or recurring cadence) was understood but
 * its clock time was missing/ambiguous; callers should ask for it.
 * @param {{requireTime?:boolean}} [options]
 */
export function parseWhen(input, now = Date.now(), timeZone = 'Asia/Karachi', options = {}) {
  const requireTime = Boolean(options?.requireTime);
  const raw = clean(input);
  if (!raw) return null;
  try {
    formatterFor(timeZone); // validate the IANA timezone before parsing
  } catch {
    return null;
  }

  const nowParts = zonedParts(now, timeZone);

  const recurring = parseRecurring(raw, now, nowParts, timeZone, requireTime);
  if (recurring) return recurring;

  // Sub-day relative intervals are exact durations. Day/week phrases below use
  // local calendar arithmetic to honour the selected wall-clock timezone.
  const relative = raw.match(
    /^(?:in\s+)?(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?:\s+from\s+now)?$/
  );
  if (relative) {
    const ms = durationMs(relative[1], relative[2]);
    if (!ms) return null;
    return { kind: 'once', runAt: now + ms, label: `in ${relative[1]} ${relative[2]}`, timeZone };
  }

  const calendarRelative = parseRelativeCalendar(raw, now, nowParts, timeZone, requireTime);
  if (calendarRelative) return calendarRelative;

  // A leading "at" has no date; a bare hour remains ambiguous and is sent
  // back to the caller for clarification rather than being guessed as AM/PM.
  const leadingAt = raw.match(/^at\s+(.+)$/);
  if (leadingAt) {
    const timeText = leadingAt[1].trim();
    let clock = parseClock(timeText);
    const today = { year: nowParts.year, month: nowParts.month, day: nowParts.day };
    if (!clock && looksLikeBareHour(timeText) && !requireTime) clock = parseLegacyClock(timeText);
    if (!clock && looksLikeBareHour(timeText)) {
      return dateOnly(today, timeZone, {
        dateExpression: 'at', ambiguousTime: true, implicitDate: true,
      });
    }
    if (!clock) return null;
    const todayAtTime = localToEpoch({ ...today, ...clock }, timeZone);
    if (todayAtTime === null) return null;
    const runAt = todayAtTime <= now
      ? localToEpoch({ ...addCalendarDays(today, 1), ...clock }, timeZone)
      : todayAtTime;
    return runAt === null ? null : { kind: 'once', runAt, label: `at ${clockLabel(clock)}`, timeZone };
  }

  // Phrases with an explicit "at" separator.
  const atIndex = raw.lastIndexOf(' at ');
  if (atIndex >= 0) {
    const dateText = raw.slice(0, atIndex).trim();
    const timeText = raw.slice(atIndex + 4).trim();
    let clock = parseClock(timeText);
    const ambiguousHour = !clock && looksLikeBareHour(timeText);
    if (!clock && ambiguousHour && !requireTime) clock = parseLegacyClock(timeText);
    if (!clock && !ambiguousHour) return null;
    const ambiguousTime = Boolean(ambiguousHour && !clock);

    if (!dateText) {
      const today = { year: nowParts.year, month: nowParts.month, day: nowParts.day };
      if (!clock) return dateOnly(today, timeZone, { dateExpression: 'at', ambiguousTime: true, implicitDate: true });
      const todayAtTime = localToEpoch({ ...today, ...clock }, timeZone);
      if (todayAtTime === null) return null;
      const runAt = todayAtTime <= now
        ? localToEpoch({ ...addCalendarDays(today, 1), ...clock }, timeZone)
        : todayAtTime;
      return runAt === null ? null : {
        kind: 'once', runAt, label: `at ${clockLabel(clock)}`, timeZone,
      };
    }

    const parsedDate = parseCalendarDate(dateText, nowParts, now, timeZone, clock);
    if (!parsedDate) return null;
    const result = makeOneTime(parsedDate, clock, now, timeZone);
    if (ambiguousTime) return { ...result, needsTime: true, ambiguousTime: true, dateExpression: parsedDate.dateExpression };
    return result;
  }

  // First recognize a whole date phrase. This prevents "September 9" from
  // being mistaken for a bare clock time.
  const legacyDefaultClock = requireTime ? null : { h: 9, m: 0 };
  const wholeDate = parseCalendarDate(raw, nowParts, now, timeZone, legacyDefaultClock);
  if (wholeDate) {
    return requireTime
      ? dateOnly(wholeDate.dateParts, timeZone, { dateExpression: wholeDate.dateExpression })
      : makeOneTime(wholeDate, legacyDefaultClock, now, timeZone);
  }

  // Also allow "tomorrow 9am", "9 September 7:20pm", and "Friday 5pm".
  const boundaries = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] === ' ') boundaries.push(i);
  }
  for (const boundary of boundaries) {
    const dateText = raw.slice(0, boundary).trim();
    const timeText = raw.slice(boundary + 1).trim();
    let clock = parseClock(timeText);
    const ambiguousHour = !clock && looksLikeBareHour(timeText);
    if (!clock && ambiguousHour && !requireTime) clock = parseLegacyClock(timeText);
    const ambiguousTime = Boolean(ambiguousHour && !clock);
    if (!clock && !ambiguousTime) continue;
    const parsedDate = parseCalendarDate(dateText, nowParts, now, timeZone, clock);
    if (!parsedDate) continue;
    const result = makeOneTime(parsedDate, clock, now, timeZone);
    if (ambiguousTime) {
      return { ...result, needsTime: true, ambiguousTime: true, dateExpression: parsedDate.dateExpression };
    }
    return result;
  }

  // A clock without a date means the next occurrence in local time.
  let bareClock = parseClock(raw);
  if (!bareClock && !requireTime) bareClock = parseLegacyClock(raw);
  if (bareClock) {
    const today = { year: nowParts.year, month: nowParts.month, day: nowParts.day };
    const todayAtTime = localToEpoch({ ...today, ...bareClock }, timeZone);
    if (todayAtTime === null) return null;
    const runAt = todayAtTime <= now
      ? localToEpoch({ ...addCalendarDays(today, 1), ...bareClock }, timeZone)
      : todayAtTime;
    return runAt === null ? null : {
      kind: 'once', runAt, label: `at ${clockLabel(bareClock)}`, timeZone,
    };
  }

  return null;
}

/** Format a concrete epoch for a human-facing preview in the chosen timezone. */
export function formatDateTime(epochMs, timeZone = 'Asia/Karachi') {
  try {
    const date = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(epochMs));
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12',
    }).format(new Date(epochMs)).toLowerCase();
    return `${date} at ${time} (${timeZone})`;
  } catch {
    return `${new Date(epochMs).toISOString()} (${timeZone})`;
  }
}

export default { parseWhen, parseClock, formatDateTime };
