const { test } = require('node:test');
const assert = require('node:assert');
const { mondayOf, weekStartInstant, weekDates } = require('../lib/sphere360/week');

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
