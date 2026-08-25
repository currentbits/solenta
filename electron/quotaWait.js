"use strict";

/**
 * Provider quota-wait (#462): parse a reset clock from a provider error.
 *
 * Distinct from Solenta's own budget cap (#286) and from model failover
 * (#294). A reset timestamp means the turn is waiting on a clock. Exhausted
 * balance with no clock is a hard fail — do not retry-storm.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Weekly limits plus slack. Longer than this is treated as a parse bug. */
const MAX_WAIT_MS = 8 * DAY_MS;
const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const QUOTA_RE =
  /usage[_\s-]?limit|hit your (?:session |weekly |daily )?(?:limit|cap)|rate[_ ]?limit|\b429\b|quota[_\s-]?(?:exceeded|exhausted)|exceeded your (?:current )?quota|out of credits|insufficient (?:quota|credits|balance)|balance (?:is )?exhausted|account quota|limit reached/i;

const CONTEXT_OVERFLOW_COPY =
  "Context window is full. Fork to fresh context or rewind the last turn.";

const CONTEXT_OVERFLOW_RE =
  /context[_\s-]?length[_\s-]?exceeded|prompt is too long|maximum context (?:length|window)|context window(?: is)? (?:completely )?full\b|context window.{0,80}(?:exceed|too (?:long|large))|exceeds?.{0,40}(?:the |this model'?s )?context window|(?:input|prompt|request).{0,80}too (?:long|large).{0,80}(?:model'?s? )?context window|ran out of room in the model'?s context window|input length and max_tokens exceed context limit/i;

const OWN_BUDGET_RE =
  /daily budget|orchestration budget|crew auto-turn cap|spend cap/i;

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function isQuotaLike(text) {
  const s = String(text ?? "");
  if (!s.trim()) return false;
  if (OWN_BUDGET_RE.test(s)) return false;
  return QUOTA_RE.test(s);
}

/**
 * High-confidence provider context overflow; deliberately excludes generic
 * "limit reached", quota, and output-token wording.
 * @param {unknown} text
 */
function isContextOverflow(text) {
  const s = String(text ?? "").trim();
  return Boolean(s && CONTEXT_OVERFLOW_RE.test(s));
}

/**
 * Targeted recovery copy plus at most two provider-detail lines.
 * @param {unknown} text
 * @returns {{ kind: "context-overflow", text: string } | null}
 */
function classifyContextOverflow(text) {
  const raw = String(text ?? "").trim();
  if (!isContextOverflow(raw)) return null;
  const detail = raw
    .split(/\r?\n/)
    .slice(0, 2)
    .join("\n")
    .slice(0, 500);
  return {
    kind: "context-overflow",
    text: `${CONTEXT_OVERFLOW_COPY}\nProvider error: ${detail}`,
  };
}

/**
 * @param {string} tz
 * @returns {string | null}
 */
function validTimeZone(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return tz;
  } catch {
    return null;
  }
}

/**
 * Clock in a zone: "3pm", "3:05pm", "15:00", "11:50am".
 * @param {string} raw
 * @returns {{ hours: number, minutes: number } | null}
 */
function parseClock(raw) {
  const s = String(raw || "").trim().toLowerCase();
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (m) {
    let hours = Number(m[1]);
    const minutes = m[2] ? Number(m[2]) : 0;
    const ap = m[3].toLowerCase();
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    if (ap === "am") hours = hours === 12 ? 0 : hours;
    else hours = hours === 12 ? 12 : hours + 12;
    return { hours, minutes };
  }
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
  }
  return null;
}

/**
 * Instant for (hours:minutes) on the calendar day of `now` in `timeZone`.
 * @param {number} now
 * @param {number} hours
 * @param {number} minutes
 * @param {string | null} timeZone
 * @returns {number}
 */
/**
 * UTC ms for a civil wall time in `timeZone`. Treats the numbers as that
 * zone's clock, not the host's.
 */
function zonedCivilToUtc(year, month /* 1-12 */, day, hours, minutes, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hours, minutes, 0);
  // Pretend the civil time is UTC, then slide by however far that instant
  // reads in the named zone. One correction is enough except at a DST
  // overlap; a second pass lands on the earlier offset.
  let utc = desired;
  for (let i = 0; i < 2; i++) {
    const check = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utc));
    const cg = (type) => {
      const p = check.find((x) => x.type === type);
      return p ? Number(p.value) : NaN;
    };
    const shown = Date.UTC(cg("year"), cg("month") - 1, cg("day"), cg("hour"), cg("minute"), 0);
    utc += desired - shown;
  }
  return utc;
}

function zoneParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return { year: get("year"), month: get("month"), day: get("day") };
}

function atTimeOnDay(now, hours, minutes, timeZone) {
  if (!timeZone) {
    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    return d.getTime();
  }
  const { year, month, day } = zoneParts(now, timeZone);
  return zonedCivilToUtc(year, month, day, hours, minutes, timeZone);
}

/**
 * @param {number} now
 * @param {number} month 0-11
 * @param {number} day
 * @param {number} hours
 * @param {number} minutes
 * @param {string | null} timeZone
 * @returns {number}
 */
function atDateTime(now, month, day, hours, minutes, timeZone) {
  const year = timeZone
    ? zoneParts(now, timeZone).year
    : new Date(now).getFullYear();
  const tryYear = (y) => {
    if (!timeZone) {
      return new Date(y, month, day, hours, minutes, 0, 0).getTime();
    }
    return zonedCivilToUtc(y, month + 1, day, hours, minutes, timeZone);
  };
  let ts = tryYear(year);
  if (ts <= now) ts = tryYear(year + 1);
  return ts;
}

/**
 * @param {string} s
 * @param {number} now
 * @returns {number | null}
 */
function extractResetAt(s, now) {
  const iso = s.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/,
  );
  if (iso) {
    const t = Date.parse(iso[0]);
    if (Number.isFinite(t)) return t;
  }

  const dur = s.match(
    /\b(?:resets?\s+in|try again in|retry(?:-|\s)?after)\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours|d|day|days)\b/i,
  );
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith("s")) ms = n * 1000;
    else if (unit.startsWith("m")) ms = n * 60 * 1000;
    else if (unit.startsWith("h")) ms = n * HOUR_MS;
    else ms = n * DAY_MS;
    if (ms > 0) return now + ms;
  }

  const retryHeader = s.match(/\bretry-after:\s*(\d+)\b/i);
  if (retryHeader) {
    const sec = Number(retryHeader[1]);
    if (sec > 0) return now + sec * 1000;
  }

  const tzMatch = s.match(
    /\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\)/,
  );
  const timeZone = tzMatch ? validTimeZone(tzMatch[1]) : null;

  const dated = s.match(
    /\b(?:resets?(?:\s+at)?|reset at|will reset at)\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?[, ]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\b/i,
  );
  if (dated) {
    const month = MONTHS[dated[1].slice(0, 3).toLowerCase()];
    const day = Number(dated[2]);
    const clock = parseClock(dated[4]);
    if (month != null && day >= 1 && day <= 31 && clock) {
      if (dated[3]) {
        const year = Number(dated[3]);
        if (!timeZone) {
          return new Date(
            year,
            month,
            day,
            clock.hours,
            clock.minutes,
            0,
            0,
          ).getTime();
        }
        return atDateTime(
          new Date(year, month, day).getTime(),
          month,
          day,
          clock.hours,
          clock.minutes,
          timeZone,
        );
      }
      return atDateTime(now, month, day, clock.hours, clock.minutes, timeZone);
    }
  }

  const clockMatch = s.match(
    /\b(?:resets?(?:\s+at)?|reset at|will reset at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})\b/i,
  );
  if (clockMatch) {
    const clock = parseClock(clockMatch[1]);
    if (clock) {
      let ts = atTimeOnDay(now, clock.hours, clock.minutes, timeZone);
      if (ts <= now) ts += DAY_MS;
      return ts;
    }
  }

  return null;
}

/**
 * @param {unknown} text
 * @param {number} [now]
 * @returns {{ kind: "reset" | "exhausted", resetAt: number | null } | null}
 */
function parseQuotaError(text, now = Date.now()) {
  const s = String(text ?? "");
  if (!isQuotaLike(s)) return null;
  const resetAt = extractResetAt(s, now);
  if (resetAt != null && Number.isFinite(resetAt)) {
    return { kind: "reset", resetAt };
  }
  return { kind: "exhausted", resetAt: null };
}

/**
 * Per-thread override wins; absent/null inherits the global default (on).
 * @param {{ quotaWaitAutoResume?: boolean | null } | null | undefined} thread
 * @param {{ quotaWaitAutoResume?: boolean } | null | undefined} settings
 */
function quotaWaitEnabled(thread, settings) {
  if (thread && thread.quotaWaitAutoResume === false) return false;
  if (thread && thread.quotaWaitAutoResume === true) return true;
  return !settings || settings.quotaWaitAutoResume !== false;
}

/**
 * Whether this error should park the thread instead of failing it.
 * Wake-once: a thread that already resumed from a quota-wait cannot park again.
 * @param {object} opts
 * @param {unknown} opts.text
 * @param {{ quotaWaitAutoResume?: boolean | null, quotaWaitResumed?: boolean } | null | undefined} opts.thread
 * @param {{ quotaWaitAutoResume?: boolean } | null | undefined} opts.settings
 * @param {number} [opts.now]
 * @returns {{ until: number } | null}
 */
function decideQuotaWait(opts) {
  const now = Number.isFinite(opts && opts.now) ? opts.now : Date.now();
  const thread = opts && opts.thread;
  if (thread && thread.quotaWaitResumed) return null;
  if (!quotaWaitEnabled(thread, opts && opts.settings)) return null;
  const parsed = parseQuotaError(opts && opts.text, now);
  if (!parsed || parsed.kind !== "reset" || parsed.resetAt == null) return null;
  if (parsed.resetAt - now > MAX_WAIT_MS) return null;
  return { until: Math.max(parsed.resetAt, now + 1000) };
}

function timeOfDayLabel(ms) {
  const d = new Date(ms);
  const hours = d.getHours();
  const mins = d.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return mins === 0
    ? `${h12}${ampm}`
    : `${h12}:${String(mins).padStart(2, "0")}${ampm}`;
}

/**
 * Human wake label: "3pm", "tomorrow 3pm", "Mon 3pm".
 * @param {number} until
 * @param {number} [now]
 */
function formatQuotaWaitClock(until, now = Date.now()) {
  if (!Number.isFinite(until)) return "—";
  const d = new Date(until);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  const tomorrow = new Date(n);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  const time = timeOfDayLabel(until);
  if (sameDay) return time;
  if (isTomorrow) return `tomorrow ${time}`;
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday} ${time}`;
}

module.exports = {
  isQuotaLike,
  isContextOverflow,
  classifyContextOverflow,
  parseQuotaError,
  quotaWaitEnabled,
  decideQuotaWait,
  formatQuotaWaitClock,
  MAX_WAIT_MS,
};
