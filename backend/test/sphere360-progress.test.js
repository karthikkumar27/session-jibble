const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeCycle, isBillableEntry } = require('../lib/sphere360/progress');
const { cycleFor } = require('../lib/sphere360/cycle');

// The fixture IS the operator's live "MY BILLABLE PROGRESS" card for
// 26 Aug - 25 Sep 2026:
//
//   BILLED   13h      (1.63 days)    Actual  7.1%
//   TARGET   134h 24m (16.80 days)   Target  73%
//   Day 3 of 23 working days . 20 remaining
//
// 8.00h was filed on 26 Aug, of which 1h is a non-billable social row — which
// is exactly why BILLED reads 13 and not 14.

const CYCLE = cycleFor('2026-08-30');
const MAPPING = { dailyMinimumHours: 8, projects: [], holidays: [] };
const RESOURCE = { weeklyCapacityHours: 40, targetUtilization: 73 };

const billable = (workDate, hours, extra = {}) =>
  ({ workDate, hours, activityId: 'a', isBillable: true, activity: { isBillable: true }, ...extra });
const nonBillable = (workDate, hours) =>
  ({ workDate, hours, activityId: 'social', isBillable: false, activity: { isBillable: false } });

const week = (weekStart, entries, resource = RESOURCE) =>
  ({ weekStart, week: { status: 'DRAFT', resource }, entries });

// 13 billable hours spread across the cycle, plus one non-billable row.
const LIVE_WEEKS = [
  week('2026-08-24', [billable('2026-08-26', 7), nonBillable('2026-08-26', 1)]),
  week('2026-08-31', [billable('2026-09-01', 4)]),
  week('2026-09-07', [billable('2026-09-09', 2)]),
  week('2026-09-14', []),
  week('2026-09-21', []),
];

const summary = (over) => summarizeCycle({
  cycle: CYCLE, today: '2026-08-28', weeks: LIVE_WEEKS, mapping: MAPPING, ...over,
});

test('reproduces every figure on the live billable-progress card', () => {
  const s = summary();
  assert.equal(s.workingDays, 23);
  assert.equal(s.elapsedWorkingDays, 3);
  assert.equal(s.remainingWorkingDays, 20);
  assert.equal(s.dailyHours, 8);
  assert.equal(s.dailyHoursSource, 'sphere360');
  assert.equal(s.capacityHours, 184);
  assert.equal(s.targetPercent, 73);
  // 134.4h renders "134h 24m", and 134.4/8 = 16.8 days renders "16.80 days" —
  // both exactly as the card does. It is NOT 73% of 184 (that is 134.32,
  // "134h 19m"): the target is rounded to one decimal in DAYS first. See the
  // derivation in progress.js.
  assert.equal(s.targetHours, 134.4);
  assert.equal(s.targetDays, 16.8);
  assert.equal(s.billedHours, 13);
  assert.equal(s.billableDays, 1.63);
  assert.equal(s.actualPercent, 7.1);
  assert.deepEqual(s.weekErrors, []);
});

test('excludes non-billable rows from BILLED', () => {
  // Summing hours indiscriminately gives 14 and 7.6% — the card says 13 and
  // 7.1%. The operator confirmed the excluded row is a social event.
  const s = summary();
  assert.equal(s.billedHours, 13);
  const naive = LIVE_WEEKS.flatMap(w => w.entries).reduce((n, e) => n + e.hours, 0);
  assert.equal(naive, 14, 'fixture must contain a non-billable hour for this test to bite');
});

test('counts only the days inside the cycle, not the whole weeks fetched', () => {
  // The first week fetched (Mon 24 Aug) opens two days BEFORE the cycle, and
  // those days belong to the previous cycle's card. Summing the fetched weeks
  // wholesale would bill them twice — once in each cycle.
  const s = summary({
    weeks: [
      week('2026-08-24', [billable('2026-08-24', 6), billable('2026-08-25', 6), billable('2026-08-26', 7)]),
      ...LIVE_WEEKS.slice(1),
    ],
  });
  assert.equal(s.billedHours, 13);
});

test('excludes days after the cycle ends, on the closing week', () => {
  // The last week fetched (Mon 21 Sep) runs to 27 Sep, two days into the NEXT
  // cycle.
  const s = summary({
    weeks: [...LIVE_WEEKS.slice(0, 4), week('2026-09-21', [billable('2026-09-26', 8), billable('2026-09-27', 8)])],
  });
  assert.equal(s.billedHours, 13);
});

test('a failed week is recorded and the totals come from the weeks that succeeded', () => {
  // A cycle spans five weeks. One expired token or 500 must not blank a card
  // the operator uses to decide whether they are behind.
  const s = summary({
    weeks: [
      LIVE_WEEKS[0],
      { weekStart: '2026-08-31', error: { code: 'HTTP', message: 'Sphere360 returned 500' } },
      ...LIVE_WEEKS.slice(2),
    ],
  });
  assert.equal(s.billedHours, 9);            // 13 minus the 4h in the failed week
  assert.deepEqual(s.weekErrors, [
    { weekStart: '2026-08-31', code: 'HTTP', message: 'Sphere360 returned 500' },
  ]);
  // The cycle's own shape is unaffected by a fetch failure: it is calendar
  // arithmetic, not data.
  assert.equal(s.workingDays, 23);
  assert.equal(s.capacityHours, 184);
});

test('every week failing yields zero billed and five errors, never a thrown card', () => {
  const s = summary({
    weeks: LIVE_WEEKS.map(w => ({ weekStart: w.weekStart, error: { code: 'AUTH', message: 'token expired' } })),
  });
  assert.equal(s.billedHours, 0);
  assert.equal(s.weekErrors.length, 5);
  assert.equal(s.actualPercent, 0);
});

test('falls back to the mapping\'s daily minimum, and says so, when no week has a resource', () => {
  // A cycle with no timesheet filed anywhere carries no resource. The card
  // must not silently present a configured guess as Sphere360's own figure.
  const s = summary({
    weeks: [{ weekStart: '2026-08-24', week: null, entries: [] }],
    mapping: { ...MAPPING, dailyMinimumHours: 7.5 },
  });
  assert.equal(s.dailyHours, 7.5);
  assert.equal(s.dailyHoursSource, 'config');
  assert.equal(s.capacityHours, 172.5);
  // targetUtilization has no configured fallback — inventing 73 would put a
  // number on the card that Sphere360 never said.
  assert.equal(s.targetPercent, null);
  assert.equal(s.targetHours, null);
  assert.equal(s.targetDays, null);
});

test('takes the resource from whichever week actually has one', () => {
  // The first week of a cycle often has no timesheet yet. Reading weeks[0]
  // blindly would report the configured fallback while a later week states
  // the real capacity.
  const s = summary({
    weeks: [
      { weekStart: '2026-08-24', week: null, entries: [billable('2026-08-26', 7)] },
      week('2026-08-31', [billable('2026-09-01', 6)]),
    ],
  });
  assert.equal(s.dailyHours, 8);
  assert.equal(s.dailyHoursSource, 'sphere360');
  assert.equal(s.targetPercent, 73);
});

test('billableDays and actualPercent divide by the cycle\'s own capacity', () => {
  // 13/8 = 1.625 -> 1.63 days; 13/184 = 7.065% -> 7.1%. Dividing the days by
  // anything but dailyHours, or the percent by anything but capacityHours,
  // breaks one of the two.
  const s = summary();
  assert.equal(s.billableDays, 1.63);
  assert.equal(s.actualPercent, 7.1);
  assert.equal(parseFloat((s.targetHours / s.dailyHours).toFixed(2)), 16.80);
});

test('isBillableEntry trusts the row\'s own flag over the nested activity', () => {
  // Both are present on live rows. A row explicitly marked non-billable must
  // not be rescued by its activity's default, or the social row rejoins BILLED.
  assert.equal(isBillableEntry({ isBillable: false, activity: { isBillable: true } }), false);
  assert.equal(isBillableEntry({ isBillable: true, activity: { isBillable: false } }), true);
  // Older rows may carry only the nested flag.
  assert.equal(isBillableEntry({ activity: { isBillable: true } }), true);
  // Neither: unknown is not billable. Over-reporting BILLED is the failure
  // that would have the operator stop filing while they are actually behind.
  assert.equal(isBillableEntry({ hours: 3 }), false);
  assert.equal(isBillableEntry(null), false);
});

test('ignores an unusable hours value instead of poisoning the total with NaN', () => {
  // One bad row would turn every figure on the card into NaN.
  const s = summary({
    weeks: [week('2026-08-24', [billable('2026-08-26', 7), billable('2026-08-27', null), billable('2026-08-28', 'x')])],
  });
  assert.equal(s.billedHours, 7);
  assert.equal(s.actualPercent, 3.8);
});

test('rounds the target to one decimal in DAYS, then multiplies by the daily hours', () => {
  // The exact observed case, from the operator's own live card:
  // workingDays 23, targetUtilization 73%, dailyHours 8.
  //
  //   raw target days     0.73 x 23       = 16.79
  //   round to 1 decimal  round(16.79, 1) = 16.8    -> card shows "16.80 days"
  //   target hours        16.8 x 8        = 134.4   -> card shows "134h 24m"
  //
  // The rounding place is not a matter of taste — only 1dp reproduces the
  // card. The other two were checked against it and rejected:
  //   0dp -> 17.0  days = 136h 00m   (no)
  //   2dp -> 16.79 days = 134h 19m   (no)
  // So the 1dp step is the RULE, not a display artefact of one. Deriving
  // hours from the unrounded product instead — targetPercent/100 x
  // capacityHours — gives 134.32 and puts this app 5 minutes below the
  // dashboard it exists to mirror, on every cycle.
  const s = summary();
  assert.equal(s.targetDays, 16.8);
  assert.equal(s.targetHours, 134.4);
});

test('the rounded target days survive as the figure the card renders', () => {
  // targetDays is returned in its own right rather than left for the UI to
  // divide back out of targetHours: a UI-side targetHours/dailyHours would
  // reintroduce the unrounded value the rounding just removed.
  const s = summary();
  assert.equal(s.targetDays.toFixed(2), '16.80');
  assert.equal(parseFloat((s.targetHours / s.dailyHours).toFixed(2)), 16.80);
});
