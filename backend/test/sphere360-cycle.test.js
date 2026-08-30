const { test } = require('node:test');
const assert = require('node:assert');
const {
  cycleFor, workingDaysIn, elapsedWorkingDays, weekStartsIn, cycleLabel, datesIn,
} = require('../lib/sphere360/cycle');

// Every number below is taken from the operator's live Sphere360 "MY BILLABLE
// PROGRESS" card for the cycle 26 Aug - 25 Sep 2026, which reads:
//
//   BILLED   13h      (1.63 days)    Actual  7.1%
//   TARGET   134h 24m (16.80 days)   Target  73%
//   Day 3 of 23 working days . 20 remaining
//
// The card is the specification. Where a plausible-looking rule disagrees with
// it, the card wins.

test('a cycle runs the 26th of one month to the 25th of the next', () => {
  // The trap: Sphere360's OTHER period model is the calendar month, and the
  // plan-vs-actual endpoint speaks it. A calendar-month implementation would
  // answer 2026-08-01 / 2026-08-31 here, and every hour filed on the 26th-31st
  // would be counted into the wrong cycle.
  assert.deepEqual(cycleFor('2026-08-30'), {
    start: '2026-08-26', end: '2026-09-25', monthKey: '2026-09',
  });
});

test('a cycle is addressed by its END month, not the month it starts in', () => {
  assert.equal(cycleFor('2026-08-30').monthKey, '2026-09');
  assert.equal(cycleFor('2026-09-20').monthKey, '2026-09');
});

test('the 25th closes a cycle and the 26th opens the next one', () => {
  // An off-by-one here (day > 26 instead of >= 26, or day > 25 for the close)
  // silently moves a whole day of billing between two cycles.
  assert.equal(cycleFor('2026-09-25').start, '2026-08-26');
  assert.equal(cycleFor('2026-09-25').end, '2026-09-25');
  assert.equal(cycleFor('2026-09-26').start, '2026-09-26');
  assert.equal(cycleFor('2026-09-26').end, '2026-10-25');
});

test('a cycle spanning New Year rolls the year, not just the month', () => {
  // Month + 1 without a year roll produces '2026-13-25', which week.js's
  // assertLocalDate refuses — so this fails loudly rather than mis-labelling.
  assert.deepEqual(cycleFor('2026-12-30'), {
    start: '2026-12-26', end: '2027-01-25', monthKey: '2027-01',
  });
  assert.deepEqual(cycleFor('2027-01-25'), {
    start: '2026-12-26', end: '2027-01-25', monthKey: '2027-01',
  });
  assert.deepEqual(cycleFor('2027-01-26'), {
    start: '2027-01-26', end: '2027-02-25', monthKey: '2027-02',
  });
});

test('cycleFor refuses a calendar-invalid date instead of sliding to another cycle', () => {
  // Reuses week.js's own validation rather than a second copy of it.
  assert.throws(() => cycleFor('2026-02-30'), /YYYY-MM-DD/);
  assert.throws(() => cycleFor('30-08-2026'), /YYYY-MM-DD/);
});

test('workingDaysIn counts Mon-Fri and matches the live card exactly', () => {
  assert.equal(workingDaysIn('2026-08-26', '2026-09-25'), 23);
});

test('workingDaysIn does NOT deduct public holidays', () => {
  // The cycle above contains two Malaysian public holidays — Merdeka Day
  // (Mon 2026-08-31) and Malaysia Day (Wed 2026-09-16) — and Sphere360 still
  // reports 23, not 21. Its 73% target utilisation is the slack that already
  // absorbs holidays and leave; deducting them here too double-counts it.
  // This asserts the count is unchanged by dates a holiday-aware version
  // would have removed.
  assert.equal(workingDaysIn('2026-08-31', '2026-08-31'), 1);   // Merdeka, a Monday
  assert.equal(workingDaysIn('2026-09-16', '2026-09-16'), 1);   // Malaysia Day, a Wednesday
});

test('workingDaysIn excludes weekends', () => {
  assert.equal(workingDaysIn('2026-08-29', '2026-08-30'), 0);   // Sat + Sun
  assert.equal(workingDaysIn('2026-08-24', '2026-08-30'), 5);   // a whole week
  assert.equal(workingDaysIn('2026-08-24', '2026-08-24'), 1);
});

test('workingDaysIn refuses a reversed range rather than answering 0', () => {
  // 0 is indistinguishable from "a two-day weekend", and it would divide into
  // the capacity as a silent zero.
  assert.throws(() => workingDaysIn('2026-09-25', '2026-08-26'), /before/);
});

test('elapsedWorkingDays reproduces the card\'s "Day 3 of 23"', () => {
  assert.equal(elapsedWorkingDays('2026-08-26', '2026-08-28', '2026-09-25'), 3);
});

test('elapsedWorkingDays counts working days, not calendar days', () => {
  // 26 Aug -> 31 Aug inclusive is 6 calendar days but only 4 working ones
  // (Wed, Thu, Fri, Mon). A calendar-day count would say 6 and put the card
  // two days ahead of itself.
  assert.equal(elapsedWorkingDays('2026-08-26', '2026-08-31', '2026-09-25'), 4);
});

test('elapsedWorkingDays counts today itself, not up to yesterday', () => {
  // Sphere360 says "Day 3" on the third working day, not "Day 2".
  assert.equal(elapsedWorkingDays('2026-08-26', '2026-08-26', '2026-09-25'), 1);
});

test('elapsedWorkingDays never exceeds the cycle it is measuring', () => {
  // Viewing a past cycle passes a `today` beyond its end. Unclamped, this
  // would keep counting forward and report "Day 47 of 23".
  assert.equal(elapsedWorkingDays('2026-08-26', '2026-11-10', '2026-09-25'), 23);
});

test('elapsedWorkingDays is 0 before the cycle starts', () => {
  // Viewing a future cycle. A signed day-difference would go negative here.
  assert.equal(elapsedWorkingDays('2026-08-26', '2026-08-01', '2026-09-25'), 0);
});

test('weekStartsIn returns the Monday of every week the cycle touches', () => {
  // Starts at the Monday BEFORE the cycle start (24 Aug), because the cycle
  // opens mid-week on a Wednesday and Sphere360 stores timesheets by week.
  // Fetching from 2026-08-26 instead would miss the week carrying 26-28 Aug —
  // three working days of billing, including the card's own 13h.
  assert.deepEqual(weekStartsIn('2026-08-26', '2026-09-25'), [
    '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21',
  ]);
});

test('weekStartsIn stops at the last week that overlaps, and never repeats one', () => {
  // 2026-09-28 is the Monday after the cycle ends and must not appear.
  const weeks = weekStartsIn('2026-08-26', '2026-09-25');
  assert.equal(weeks.length, 5);
  assert.equal(new Set(weeks).size, 5);
  assert.ok(!weeks.includes('2026-09-28'));
  // A cycle contained in one week yields exactly that week.
  assert.deepEqual(weekStartsIn('2026-08-26', '2026-08-27'), ['2026-08-24']);
});

test('datesIn lists every calendar date in the cycle, weekends included', () => {
  const dates = datesIn('2026-08-26', '2026-09-25');
  assert.equal(dates.length, 31);          // 6 in August + 25 in September
  assert.equal(dates[0], '2026-08-26');
  assert.equal(dates.at(-1), '2026-09-25');
  assert.ok(dates.includes('2026-08-29')); // a Saturday: measured hours count on it
});

test('cycleLabel renders the card\'s own heading', () => {
  assert.equal(cycleLabel('2026-08-26', '2026-09-25'), '26 Aug – 25 Sep 2026');
});

test('cycleLabel names both years when the cycle crosses New Year', () => {
  // '26 Dec – 25 Jan 2027' would read as December 2027.
  assert.equal(cycleLabel('2026-12-26', '2027-01-25'), '26 Dec 2026 – 25 Jan 2027');
});
