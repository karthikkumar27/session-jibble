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

module.exports = { mondayOf, weekStartInstant, weekDates };
