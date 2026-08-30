const { test } = require('node:test');
const assert = require('node:assert');
const { buildDraft } = require('../lib/sphere360/draft');

const mapping = {
  version: 1,
  resourceId: 'r1',
  dailyMinimumHours: 8,
  projects: [
    { label: 'SkyIQ / Dev', roots: ['/work/skyiq'], projectId: '1804361', activityId: 'act-dev' },
    { label: 'SkyIQ / Scrum', roots: ['/work/scrum'], projectId: '1804361', activityId: 'act-scrum' },
    { label: 'Other Project', roots: ['/other'], projectId: '1804362', activityId: 'act-other' },
  ],
};

const hours = (table) => (projectPath, date) => table[`${projectPath}|${date}`] ?? 0;

test('collapses two repos under one project+activity into a single entry', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'finishing FE tasks', dates: ['2026-08-26'] },
      { projectPath: '/work/skyiq/reports', sessionId: 's2', excerpt: 'aligning repos', dates: ['2026-08-26'] },
    ],
    mapping,
    hoursFor: hours({ '/work/skyiq/web|2026-08-26': 3.2, '/work/skyiq/reports|2026-08-26': 1.8 }),
  });

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    projectId: '1804361',
    activityId: 'act-dev',
    workDate: '2026-08-26',
    hours: 5,
    comments: 'web - finishing FE tasks\nreports - aligning repos',
  });
});

test('keeps different activityIds as separate entries on the same day', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'dev', dates: ['2026-08-26'] },
      { projectPath: '/work/scrum/notes', sessionId: 's2', excerpt: 'standup', dates: ['2026-08-26'] },
    ],
    mapping,
    hoursFor: hours({ '/work/skyiq/web|2026-08-26': 5, '/work/scrum/notes|2026-08-26': 1 }),
  });

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.activityId).sort(), ['act-dev', 'act-scrum']);
});

test('calls hoursFor once per (projectPath, date) even across multiple sessions', () => {
  // Two sessions in the same repo on the same day must not bill that day twice.
  const calls = [];
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'morning', dates: ['2026-08-26'] },
      { projectPath: '/work/skyiq/web', sessionId: 's2', excerpt: 'afternoon', dates: ['2026-08-26'] },
    ],
    mapping,
    hoursFor: (p, d) => { calls.push(`${p}|${d}`); return 4; },
  });

  assert.equal(calls.length, 1);
  assert.equal(entries[0].hours, 4);
  assert.equal(entries[0].comments, 'web - morning; afternoon');
});

test('excludes dates outside the requested week', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'in', dates: ['2026-08-26'] },
      { projectPath: '/work/skyiq/web', sessionId: 's2', excerpt: 'out', dates: ['2026-09-02'] },
    ],
    mapping,
    hoursFor: () => 2,
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].workDate, '2026-08-26');
});

test('reports unmapped folders instead of silently dropping them', () => {
  const { entries, unmapped } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/home/me/side-project', sessionId: 's1', excerpt: 'hobby', dates: ['2026-08-26', '2026-08-27'] },
    ],
    mapping,
    hoursFor: () => 0.2,
  });

  assert.deepEqual(entries, []);
  assert.deepEqual(unmapped, [{ projectPath: '/home/me/side-project', hours: 0.4 }]);
});

test('drops a group whose measured hours round to zero', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [{ projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'blip', dates: ['2026-08-26'] }],
    mapping,
    hoursFor: () => 0,
  });
  assert.deepEqual(entries, []);
});

test('orders entries by date then project then activity, deterministically', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      // Supplied in reverse order of expected sorted output to verify all three tiebreakers are exercised
      { projectPath: '/work/scrum/n', sessionId: 's1', excerpt: 'z', dates: ['2026-08-27'] },  // last after sort (2026-08-27)
      { projectPath: '/other/x', sessionId: 's2', excerpt: 'y', dates: ['2026-08-25'] },       // 3rd after sort (projectId tiebreaker)
      { projectPath: '/work/scrum/n', sessionId: 's3', excerpt: 'x', dates: ['2026-08-25'] },  // 2nd after sort (activityId tiebreaker)
      { projectPath: '/work/skyiq/w', sessionId: 's4', excerpt: 'w', dates: ['2026-08-25'] },  // 1st after sort
    ],
    mapping,
    hoursFor: () => 1,
  });

  assert.deepEqual(
    entries.map(e => `${e.workDate}/${e.projectId}/${e.activityId}`),
    ['2026-08-25/1804361/act-dev', '2026-08-25/1804361/act-scrum', '2026-08-25/1804362/act-other', '2026-08-27/1804361/act-scrum']
  );
});

test('rounds summed hours to two decimals', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/a', sessionId: 's1', excerpt: 'x', dates: ['2026-08-26'] },
      { projectPath: '/work/skyiq/b', sessionId: 's2', excerpt: 'y', dates: ['2026-08-26'] },
    ],
    mapping,
    hoursFor: () => 0.335,
  });
  assert.equal(entries[0].hours, 0.67);
});

// --- the Jibble cutover ------------------------------------------------------
// Everything before 2026-08-27 belongs to a period already reconciled in
// Jibble (2026-08-26 was hand-entered into Sphere360), so it must never be
// drafted. It must also never be silently dropped: an absence with no
// explanation is the exact failure the `unmapped` list exists to prevent, so
// excluded days come back with their measured hours for the UI to explain.

const cutoverMapping = { ...mapping, syncFrom: '2026-08-27' };

test('never drafts a date before the cutover, and reports it instead of dropping it', () => {
  const { entries, beforeCutover } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'jibble era', dates: ['2026-08-24'] },
      { projectPath: '/work/skyiq/web', sessionId: 's2', excerpt: 'sphere era', dates: ['2026-08-27'] },
    ],
    mapping: cutoverMapping,
    hoursFor: hours({ '/work/skyiq/web|2026-08-24': 6.14, '/work/skyiq/web|2026-08-27': 3 }),
  });

  assert.deepEqual(entries.map(e => e.workDate), ['2026-08-27']);
  assert.deepEqual(beforeCutover, [{ date: '2026-08-24', hours: 6.14 }]);
});

test('the live case: the whole Jibble tail of the week is reported, never drafted', () => {
  // These are the figures verified against the live API — confirming this week
  // without the cutover would write 7.42h into an accounting period closed in
  // a different system.
  const { entries, beforeCutover } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'mon', dates: ['2026-08-24'] },
      { projectPath: '/work/skyiq/web', sessionId: 's2', excerpt: 'tue', dates: ['2026-08-25'] },
    ],
    mapping: cutoverMapping,
    hoursFor: hours({ '/work/skyiq/web|2026-08-24': 6.14, '/work/skyiq/web|2026-08-25': 1.28 }),
  });

  assert.deepEqual(entries, []);
  assert.deepEqual(beforeCutover, [
    { date: '2026-08-24', hours: 6.14 },
    { date: '2026-08-25', hours: 1.28 },
  ]);
});

test('the cutover date itself is drafted — the boundary is inclusive', () => {
  const { entries, beforeCutover } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'first synced day', dates: ['2026-08-27'] },
    ],
    mapping: cutoverMapping,
    hoursFor: hours({ '/work/skyiq/web|2026-08-27': 4 }),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].workDate, '2026-08-27');
  assert.deepEqual(beforeCutover, []);
});

test('sums every repo active on an excluded day into one reported figure', () => {
  const { beforeCutover } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'a', dates: ['2026-08-25'] },
      { projectPath: '/work/scrum/notes', sessionId: 's2', excerpt: 'b', dates: ['2026-08-25'] },
    ],
    mapping: cutoverMapping,
    hoursFor: hours({ '/work/skyiq/web|2026-08-25': 2.5, '/work/scrum/notes|2026-08-25': 1.25 }),
  });

  assert.deepEqual(beforeCutover, [{ date: '2026-08-25', hours: 3.75 }]);
});

test('omits an excluded day that measured nothing', () => {
  // Same rule the unmapped list follows: a zero is not an absence worth
  // explaining, and a row of "0.00 h" is noise on every pre-cutover day.
  const { beforeCutover } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'a', dates: ['2026-08-25'] },
    ],
    mapping: cutoverMapping,
    hoursFor: hours({}),
  });

  assert.deepEqual(beforeCutover, []);
});

test('an unmapped folder on an excluded day is reported as pre-cutover, not as unmapped', () => {
  // One absence, one explanation. "Add a mapping for this folder" would be
  // advice that changes nothing: the day is out of scope whatever it maps to.
  const { unmapped, beforeCutover } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/home/me/side-project', sessionId: 's1', excerpt: 'a', dates: ['2026-08-25'] },
    ],
    mapping: cutoverMapping,
    hoursFor: hours({ '/home/me/side-project|2026-08-25': 0.4 }),
  });

  assert.deepEqual(unmapped, []);
  assert.deepEqual(beforeCutover, [{ date: '2026-08-25', hours: 0.4 }]);
});

test('excludes nothing when the mapping states no cutover', () => {
  const { entries, beforeCutover } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'a', dates: ['2026-08-24'] },
    ],
    mapping,
    hoursFor: hours({ '/work/skyiq/web|2026-08-24': 6.14 }),
  });

  assert.equal(entries.length, 1);
  assert.deepEqual(beforeCutover, []);
});
