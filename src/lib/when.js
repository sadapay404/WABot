/**
 * Nexus-WA — "when" parser.
 *
 * Turns the shorthand a person actually types into a concrete time:
 *
 *   10m  2h  3d            → relative offset
 *   in 20 minutes          → relative offset, spelled out
 *   at 8pm  at 08:30       → today (or tomorrow if already passed)
 *   tomorrow 9am           → next day
 *   friday 5pm  mon 09:00  → next occurrence of that weekday
 *   every day 8am          → recurring daily
 *   every 30m / every 2h   → recurring interval
 *
 * Pure and clock-injectable so it can be tested deterministically. Anything it
 * cannot parse returns null — callers must handle that rather than guessing.
 */

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// Spelled-out unit names → ms. Kept separate from UNITS because the compact
// single-letter aliases are also regex captures in the "every …" branch.
const UNIT_WORDS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, wks: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** "8pm" / "8:30pm" / "08:30" / "8" -> { h, m } or null */
export function parseClock(text) {
  const m = String(text)
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let h = Number.parseInt(m[1], 10);
  const min = m[2] ? Number.parseInt(m[2], 10) : 0;
  const mer = m[3];

  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  // A bare "8" with no meridiem: treat as pm in the evening-range, else am.
  if (!mer && h <= 7) h = h; // keep as-is; morning is the safer default

  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/**
 * @param {string} input
 * @param {number} [now] epoch ms
 * @returns {{kind:'once'|'recurring', runAt:number, intervalMs?:number, label:string}|null}
 */
export function parseWhen(input, now = Date.now()) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return null;

  const base = new Date(now);

  // ── recurring: "every …" ───────────────────────────────────────
  const every = raw.match(/^every\s+(.+)$/);
  if (every) {
    const rest = every[1].trim();

    const dur = rest.match(/^(\d+)\s*([smhdw])$/);
    if (dur) {
      const ms = Number(dur[1]) * UNITS[dur[2]];
      if (!ms) return null;
      return { kind: 'recurring', runAt: now + ms, intervalMs: ms, label: `every ${dur[1]}${dur[2]}` };
    }

    const daily = rest.match(/^(?:day|daily)\s*(.*)$/) || rest.match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/);
    if (daily) {
      const clock = parseClock(daily[1] || '09:00');
      if (!clock) return null;
      const first = atTime(base, clock, now);
      return {
        kind: 'recurring',
        runAt: first,
        intervalMs: 86_400_000,
        label: `every day at ${pad2(clock.h)}:${pad2(clock.m)}`,
      };
    }

    const weekly = rest.match(/^(?:week|weekly)\s*(?:on\s+)?([a-z]+)\s*(.*)$/);
    if (weekly) {
      const day = WEEKDAYS[weekly[1]];
      if (day === undefined) return null;
      const clock = parseClock(weekly[2] || '09:00') || { h: 9, m: 0 };
      const first = nextWeekday(base, day, clock, now);
      return {
        kind: 'recurring',
        runAt: first,
        intervalMs: 604_800_000,
        label: `every ${weekly[1]} at ${pad2(clock.h)}:${pad2(clock.m)}`,
      };
    }
    return null;
  }

  // ── relative: "10m" / "2h" / "in 20 minutes" / "in 2 hours from now" ──
  // Both the compact and the spelled-out forms matter: "in 20 minutes" is the
  // way people actually phrase a reminder, and rejecting it reads as broken.
  const rel = raw.match(
    /^(?:in\s+)?(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)(?:\s+from\s+now)?$/
  );
  if (rel) {
    const ms = Number(rel[1]) * UNIT_WORDS[rel[2]];
    if (!ms) return null;
    return { kind: 'once', runAt: now + ms, label: `in ${rel[1]} ${rel[2]}` };
  }

  // ── "at 8pm" / "at 08:30" ──────────────────────────────────────
  const at = raw.match(/^at\s+(.+)$/);
  if (at) {
    const clock = parseClock(at[1]);
    if (!clock) return null;
    return { kind: 'once', runAt: atTime(base, clock, now), label: `at ${pad2(clock.h)}:${pad2(clock.m)}` };
  }

  // ── "tomorrow 9am" ─────────────────────────────────────────────
  const tom = raw.match(/^tomorrow(?:\s+(.+))?$/);
  if (tom) {
    const clock = parseClock(tom[1] || '09:00') || { h: 9, m: 0 };
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    d.setHours(clock.h, clock.m, 0, 0);
    return { kind: 'once', runAt: d.getTime(), label: `tomorrow ${pad2(clock.h)}:${pad2(clock.m)}` };
  }

  // ── weekday: "friday 5pm" ──────────────────────────────────────
  const wd = raw.match(/^([a-z]+)\s*(.*)$/);
  if (wd && WEEKDAYS[wd[1]] !== undefined) {
    const clock = parseClock(wd[2] || '09:00') || { h: 9, m: 0 };
    return {
      kind: 'once',
      runAt: nextWeekday(base, WEEKDAYS[wd[1]], clock, now),
      label: `${wd[1]} ${pad2(clock.h)}:${pad2(clock.m)}`,
    };
  }

  // ── bare clock time: "8pm" ─────────────────────────────────────
  const bare = parseClock(raw);
  if (bare) {
    return { kind: 'once', runAt: atTime(base, bare, now), label: `at ${pad2(bare.h)}:${pad2(bare.m)}` };
  }

  return null;
}

/** Same day at hh:mm, rolling to tomorrow if that moment has passed. */
function atTime(base, clock, now) {
  const d = new Date(base);
  d.setHours(clock.h, clock.m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Next occurrence of a weekday at hh:mm. */
function nextWeekday(base, weekday, clock, now) {
  const d = new Date(base);
  d.setHours(clock.h, clock.m, 0, 0);
  let delta = (weekday - d.getDay() + 7) % 7;
  if (delta === 0 && d.getTime() <= now) delta = 7;
  d.setDate(d.getDate() + delta);
  return d.getTime();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export default { parseWhen, parseClock };
