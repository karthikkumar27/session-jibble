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
