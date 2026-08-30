const { test } = require('node:test');
const assert = require('node:assert');
const {
  mondayOf, weekStartInstant, weekDates, workDateOf, isValidLocalDate,
  addDays, dayOfWeek, dateParts, fromDateParts,
} = require('../lib/sphere360/week');

test('mondayOf returns the same Monday for every day of that week', () => {
  for (const d of ['2026-08-24', '2026-08-26', '2026-08-30']) {
    assert.equal(mondayOf(d), '2026-08-24');
  }
});

test('mondayOf treats Sunday as the end of the week, not the start', () => {
  assert.equal(mondayOf('2026-08-30'), '2026-08-24');
  assert.equal(mondayOf('2026-08-31'), '2026-08-31');
});

test('weekStartInstant is UTC midnight of the Monday, regardless of local zone', () => {
  assert.equal(weekStartInstant('2026-08-26'), '2026-08-24T00:00:00.000Z');
});

test('weekStartInstant does not shift under UTC+8', () => {
  // The bug this guards: building the instant from a local Date would render
  // 2026-08-23T16:00:00.000Z in Kuala Lumpur. The Monday must not move.
  const prev = process.env.TZ;
  process.env.TZ = 'Asia/Kuala_Lumpur';
  try {
    assert.equal(weekStartInstant('2026-08-26'), '2026-08-24T00:00:00.000Z');
  } finally {
    process.env.TZ = prev;
  }
});

test('weekDates lists Monday through Sunday inclusive', () => {
  assert.deepEqual(weekDates('2026-08-26'), [
    '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
    '2026-08-28', '2026-08-29', '2026-08-30',
  ]);
});

test('weekDates crosses a year boundary without gaps', () => {
  assert.deepEqual(weekDates('2026-12-31'), [
    '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
    '2027-01-01', '2027-01-02', '2027-01-03',
  ]);
});

test('rejects a malformed date rather than guessing', () => {
  assert.throws(() => mondayOf('26-08-2026'), /YYYY-MM-DD/);
});

test('rejects a calendar-invalid date instead of normalising it into another week', () => {
  // Shape-only validation let '2026-02-30' through; Date.UTC normalised it to
  // Mar 2 and mondayOf() returned the week of Mar 2 — the WRONG week, on a path
  // whose next POST replaces that week wholesale.
  assert.throws(() => mondayOf('2026-02-30'), /YYYY-MM-DD/);
  assert.throws(() => mondayOf('2026-13-01'), /YYYY-MM-DD/);
  assert.throws(() => mondayOf('2025-02-29'), /YYYY-MM-DD/);
  // A real leap day still passes.
  assert.equal(mondayOf('2028-02-29'), '2028-02-28');
});

// --- workDateOf ---------------------------------------------------------------
// The API is asymmetric: it RETURNS workDate as a UTC-midnight instant and
// ACCEPTS a bare local date on write. entryKey compares workDate verbatim, so
// without a normalisation on read a filed row can never collide with a drafted
// one, and a confirm files duplicates instead of replacements.

const withTZ = (tz, fn) => {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
};

test('workDateOf normalises a UTC-midnight instant to its calendar date', () => {
  assert.equal(workDateOf('2026-08-26T00:00:00.000Z'), '2026-08-26');
});

test('workDateOf passes a bare local date through unchanged', () => {
  assert.equal(workDateOf('2026-08-26'), '2026-08-26');
});

test('workDateOf takes the instant UTC parts, never the local ones', () => {
  // THE D2 proof. Reading the instant with local getters returns 2026-08-25 in
  // any zone west of UTC: every filed row in New York would land on the
  // previous day, colliding with the wrong drafted row — or with none, leaving
  // the real one to be posted as a duplicate. Asserted from a negative-offset
  // zone precisely because the ambient machine is UTC+8, where a local read
  // happens to give the right answer and proves nothing.
  withTZ('America/New_York', () => {
    assert.equal(workDateOf('2026-08-26T00:00:00.000Z'), '2026-08-26');
  });
  // And symmetrically east of UTC, where a local read overshoots.
  withTZ('Pacific/Kiritimati', () => {
    assert.equal(workDateOf('2026-08-26T23:00:00.000Z'), '2026-08-26');
  });
});

test('workDateOf refuses anything that is neither a date nor an instant', () => {
  // A workDate we cannot read is not a row we can safely key, and an unkeyed
  // filed row is one the merge cannot protect from a week-replacing POST.
  for (const bad of [null, undefined, 42, '', 'yesterday', '26-08-2026', '2026-08-26T00:00', {}]) {
    // /Unusable workDate/, not /workDate/: the looser pattern also matches
    // "workDateOf is not a function", so it passed before the helper existed.
    assert.throws(() => workDateOf(bad), /Unusable workDate/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('workDateOf rejects a calendar-invalid instant instead of sliding it a day', () => {
  // Date.parse normalises '2026-02-30T00:00:00.000Z' to Mar 2 rather than
  // failing — the same trap assertLocalDate already closes for bare dates.
  assert.throws(() => workDateOf('2026-02-30T00:00:00.000Z'), /Unusable workDate/);
  assert.throws(() => workDateOf('2026-02-30'), /YYYY-MM-DD/);
  assert.equal(workDateOf('2028-02-29T00:00:00.000Z'), '2028-02-29');
});

// --- isValidLocalDate ----------------------------------------------------------
// mapping.js's holiday list needs shape-AND-calendar validation identical to
// assertLocalDate's, without adopting its throw. This is that check as a
// boolean, so mapping.js can reuse it inside a per-entry validation loop
// instead of growing a second '2026-02-30' trap of its own.

test('isValidLocalDate accepts a real calendar date', () => {
  assert.equal(isValidLocalDate('2026-08-26'), true);
  assert.equal(isValidLocalDate('2028-02-29'), true); // real leap day
});

test('isValidLocalDate rejects a calendar-invalid date without throwing', () => {
  // Date.UTC normalises this to Mar 2 instead of failing — exactly the trap
  // assertLocalDate closes. A boolean helper that let it through would let a
  // bogus holiday silently apply to the wrong day.
  assert.equal(isValidLocalDate('2026-02-30'), false);
  assert.equal(isValidLocalDate('2026-13-01'), false);
  assert.equal(isValidLocalDate('2025-02-29'), false); // not a leap year
});

test('isValidLocalDate rejects malformed shapes and non-strings without throwing', () => {
  for (const bad of ['26-08-2026', '2026/08/26', '2026-8-26', '', null, undefined, 42, {}, []]) {
    assert.equal(isValidLocalDate(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

// --- calendar helpers the cycle module builds on ---------------------------
// These exist so cycle.js can do month/day arithmetic without constructing a
// Date of its own. week.js stays the only module that knows how a local date
// becomes an instant; everything else asks it.

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');   // real leap day
});

test('dayOfWeek is the calendar weekday, not a local-clock one', () => {
  // The bug this guards: reading the weekday off a locally-parsed Date returns
  // the PREVIOUS day west of UTC and can shift east of it, which would move a
  // Monday out of the Mon-Fri count and change the cycle's working-day total.
  const prev = process.env.TZ;
  for (const tz of ['Asia/Kuala_Lumpur', 'America/New_York', 'UTC']) {
    process.env.TZ = tz;
    try {
      assert.equal(dayOfWeek('2026-08-24'), 1, `Monday in ${tz}`);
      assert.equal(dayOfWeek('2026-08-29'), 6, `Saturday in ${tz}`);
      assert.equal(dayOfWeek('2026-08-30'), 0, `Sunday in ${tz}`);
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  }
});

test('dateParts and fromDateParts round-trip, and refuse an impossible date', () => {
  assert.deepEqual(dateParts('2026-09-25'), { year: 2026, month: 9, day: 25 });
  assert.equal(fromDateParts(2026, 9, 25), '2026-09-25');
  assert.equal(fromDateParts(2026, 1, 5), '2026-01-05');       // zero padding
  // The same calendar check assertLocalDate applies: a caller that computed a
  // month of 13 by forgetting to roll the year must be told, not handed a
  // string that silently becomes the following February.
  assert.throws(() => fromDateParts(2026, 13, 25), /YYYY-MM-DD/);
  assert.throws(() => fromDateParts(2026, 2, 30), /YYYY-MM-DD/);
});
