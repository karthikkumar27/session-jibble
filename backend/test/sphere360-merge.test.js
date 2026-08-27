const { test } = require('node:test');
const assert = require('node:assert');
const { mergeWeek, entryKey } = require('../lib/sphere360/merge');

const scrum = { projectId: '1804361', activityId: 'act-scrum', workDate: '2026-08-26', hours: 1, comments: 'Daily scrum' };
const social = { activityId: 'act-social', workDate: '2026-08-26', hours: 1, comments: 'ice creame party' };
const meeting = { projectId: '1804361', activityId: 'act-meet', workDate: '2026-08-26', hours: 0.67, comments: 'infra sync' };
const dev = { projectId: '1804361', activityId: 'act-dev', workDate: '2026-08-26', hours: 6.37, comments: 'web - FE tasks' };

test('a filed row this app did not author survives the union verbatim', () => {
  // THE most important test in this feature. If it ever fails, a week-replacing
  // POST deletes the operator's meetings.
  const { entries } = mergeWeek({ filed: [scrum, social, meeting], drafted: [dev] });

  assert.equal(entries.length, 4);
  for (const row of [scrum, social, meeting]) {
    assert.ok(entries.some(e => JSON.stringify(e) === JSON.stringify(row)),
      `filed row lost: ${row.comments}`);
  }
});

test('an entry with no projectId still keys and survives', () => {
  const { entries } = mergeWeek({ filed: [social], drafted: [] });
  assert.deepEqual(entries, [social]);
});

test('a drafted row replaces the filed row sharing its key', () => {
  const stale = { ...dev, hours: 5, comments: 'old text' };
  const { entries, replaced } = mergeWeek({ filed: [scrum, stale], drafted: [dev] });

  assert.equal(entries.length, 2);
  assert.equal(replaced.length, 1);
  assert.equal(entries.find(e => e.activityId === 'act-dev').hours, 6.37);
  assert.ok(entries.some(e => e.activityId === 'act-scrum'));
});

test('every filed row lands in exactly one of entries or replaced', () => {
  // The invariant that makes rule 1 checkable rather than merely intended.
  const stale = { ...dev, hours: 5 };
  const filed = [scrum, social, meeting, stale];
  const { entries, replaced } = mergeWeek({ filed, drafted: [dev] });

  for (const row of filed) {
    const inEntries = entries.some(e => JSON.stringify(e) === JSON.stringify(row));
    const inReplaced = replaced.some(e => JSON.stringify(e) === JSON.stringify(row));
    assert.ok(inEntries !== inReplaced, `row neither kept nor replaced: ${JSON.stringify(row)}`);
  }
});

test('an empty draft is a no-op that returns the week unchanged', () => {
  const { entries, replaced } = mergeWeek({ filed: [scrum, social], drafted: [] });
  assert.deepEqual(entries, [scrum, social]);
  assert.deepEqual(replaced, []);
});

test('rows on different dates never collide', () => {
  const tuesday = { ...dev, workDate: '2026-08-25' };
  const { entries, replaced } = mergeWeek({ filed: [tuesday], drafted: [dev] });
  assert.equal(entries.length, 2);
  assert.deepEqual(replaced, []);
});

test('duplicate filed rows sharing a key both surface as replaced, not silently deduped', () => {
  // Intended, not accidental: if the server ever files two rows under one key,
  // a matching drafted row must not silently keep one and replace the other —
  // both go to `replaced` so the UI strikes through everything being
  // superseded, and `entries` gets the single drafted row once, not twice.
  const staleA = { ...dev, hours: 3, comments: 'first stale entry' };
  const staleB = { ...dev, hours: 2, comments: 'second stale entry' };
  const { entries, replaced } = mergeWeek({ filed: [staleA, staleB], drafted: [dev] });

  assert.equal(replaced.length, 2);
  assert.ok(replaced.includes(staleA));
  assert.ok(replaced.includes(staleB));
  assert.equal(entries.length, 1);
  assert.equal(entries[0], dev);
});

test('entryKey distinguishes a missing projectId from an empty one', () => {
  assert.equal(entryKey(social), entryKey({ ...social, projectId: '' }));
  assert.notEqual(entryKey(social), entryKey({ ...social, projectId: '1804361' }));
});

test('throws rather than posting a union that lost a row', () => {
  // Guards against a future refactor silently dropping filed rows. The guard
  // checks membership by identity, not by counting, so it fires whenever a
  // kept row goes missing from the union — including with just one filed row,
  // a case the old count-based formula could never catch (its arithmetic
  // reduced to `drafted.length < 0`, which is never true).
  assert.throws(
    () => mergeWeek({ filed: [scrum, social], drafted: [dev], __forceDrop: true }),
    /would drop/
  );
  assert.throws(
    () => mergeWeek({ filed: [scrum], drafted: [dev], __forceDrop: true }),
    /would drop/
  );
});

test('an id containing the old separator cannot alias a different triple', () => {
  // join('|') mapped both of these to '2026-08-26|a|b|c'. A false match here
  // makes mergeWeek treat an unrelated filed row as replaced — and the
  // week-replacing POST then deletes it.
  const a = { workDate: '2026-08-26', projectId: 'a|b', activityId: 'c' };
  const b = { workDate: '2026-08-26', projectId: 'a', activityId: 'b|c' };
  assert.notEqual(entryKey(a), entryKey(b));

  const { kept, replaced } = mergeWeek({ filed: [{ ...a, hours: 3, comments: 'client workshop' }], drafted: [{ ...b, hours: 1 }] });
  assert.equal(replaced.length, 0);
  assert.equal(kept.length, 1);
});

test('a missing and an empty projectId still key identically', () => {
  assert.equal(
    entryKey({ workDate: '2026-08-26', activityId: 'act-social' }),
    entryKey({ workDate: '2026-08-26', projectId: '', activityId: 'act-social' }),
  );
});
