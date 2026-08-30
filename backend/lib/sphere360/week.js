// The ONE module in this codebase allowed to call toISOString().
//
// CLAUDE.md bans it for date labels because it renders UTC and shifts the day
// for UTC+8. That rule still holds for `workDate`, which is a bare local date.
// But Sphere360's `weekStart` is genuinely a UTC-midnight *instant*, so it must
// be built from UTC parts and never from a local Date. Every date string in and
// out of this module is a local YYYY-MM-DD; only weekStartInstant returns an
// instant, and no other module may construct one.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertLocalDate(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d)) {
    throw new Error(`Expected a YYYY-MM-DD local date, got ${JSON.stringify(d)}`);
  }
  // Shape is not enough. Date.UTC normalises an impossible calendar date instead
  // of rejecting it, so '2026-02-30' becomes Mar 2 and mondayOf() silently
  // returns the WRONG WEEK — on a route whose date is free text from a URL, and
  // whose week a later POST replaces wholesale. Round-tripping the instant back
  // to a string proves no normalisation happened.
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  const back = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  if (back !== d) {
    throw new Error(`Expected a YYYY-MM-DD local date, got ${JSON.stringify(d)}`);
  }
}

// Parsed as UTC on purpose: these are calendar labels, not instants, so doing the
// arithmetic in UTC keeps it free of DST and offset effects entirely.
function toParts(localDate) {
  assertLocalDate(localDate);
  const [y, m, d] = localDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromParts(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function mondayOf(localDate) {
  const ms = toParts(localDate);
  const dow = new Date(ms).getUTCDay();       // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1;
  return fromParts(ms - backToMonday * 86_400_000);
}

function weekStartInstant(localDate) {
  return `${mondayOf(localDate)}T00:00:00.000Z`;
}

function weekDates(localDate) {
  const start = toParts(mondayOf(localDate));
  return Array.from({ length: 7 }, (_, i) => fromParts(start + i * 86_400_000));
}

// Sphere360 is asymmetric about workDate: it RETURNS a UTC-midnight instant
// ('2026-08-26T00:00:00.000Z') but ACCEPTS a bare local date ('2026-08-26') on
// write. entryKey compares workDate verbatim, so without a normalisation on
// read a filed row can never collide with a drafted one: every collision goes
// undetected and a confirm files duplicates instead of replacements.
//
// The parts must be taken in UTC. Reading the instant with local getters —
// new Date(v).getDate() — returns the PREVIOUS day everywhere west of UTC, so
// every filed row would key onto the wrong date. This module is the one place
// allowed to make that distinction, which is why the helper lives here and not
// in client.js.
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function workDateOf(value) {
  if (typeof value === 'string' && DATE_RE.test(value)) {
    assertLocalDate(value);       // a bare date still may not be calendar-invalid
    return value;
  }
  if (typeof value === 'string' && INSTANT_RE.test(value)) {
    const out = fromParts(Date.parse(value));   // fromParts reads UTC parts
    // Date.parse normalises '2026-02-30T00:00:00.000Z' to Mar 2 rather than
    // failing, exactly as Date.UTC does for bare dates. Round-tripping the
    // instant back to its own leading date is what proves no day was invented.
    if (out === value.slice(0, 10)) return out;
  }
  throw new Error(`Unusable workDate ${JSON.stringify(value)}: expected YYYY-MM-DD or a UTC instant`);
}

// Boolean twin of assertLocalDate, for callers that validate a whole list and
// need to keep going after a bad entry rather than throw on the first one —
// mapping.js's holiday list is exactly that caller. Reuses assertLocalDate
// itself rather than re-deriving the shape/calendar check, so the two can
// never drift: this module stays the only place that decides what a valid
// local date is.
function isValidLocalDate(d) {
  try {
    assertLocalDate(d);
    return true;
  } catch {
    return false;
  }
}

module.exports = { mondayOf, weekStartInstant, weekDates, workDateOf, isValidLocalDate };
