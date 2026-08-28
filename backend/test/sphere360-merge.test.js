const { test } = require('node:test');
const assert = require('node:assert');
const { mergeWeek, entryKey, weekWritable } = require('../lib/sphere360/merge');

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

// --- D3: identity through the round trip --------------------------------------
// The probe found filed entries carry `id` and `timesheetId`, plus `isBillable`
// and a nested `activity`. Posting back only our five fields would strip them.

const filedDev = {
  id: 'entry-77',
  timesheetId: 'ts-9',
  projectId: '1804361',
  activityId: 'act-dev',
  workDate: '2026-08-26',
  hours: 5,
  comments: 'yesterday text',
  activity: { isBillable: true },
  isBillable: true,
};

test('a drafted row superseding a filed row inherits its id and timesheetId', () => {
  // Without this the write is a delete-and-recreate: the filed row's id vanishes
  // from the posted array, so the server destroys row entry-77 and inserts a new
  // one. Any reference to it — an approval trail, an export already sent — is
  // broken to change one number. Carrying the id makes it an update in place.
  const { entries, replaced } = mergeWeek({ filed: [filedDev], drafted: [dev] });

  assert.equal(replaced.length, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'entry-77');
  assert.equal(entries[0].timesheetId, 'ts-9');
  // Ours are the values that change; the identity is all we borrow.
  assert.equal(entries[0].hours, 6.37);
  assert.equal(entries[0].comments, 'web - FE tasks');
});

test('inheriting an id does not mutate the filed row it came from', () => {
  // `replaced` is rendered struck through in the UI. If the union aliased the
  // filed object, editing hours would rewrite the row shown as superseded and
  // the operator would compare a number against itself.
  const filed = { ...filedDev };
  const { entries } = mergeWeek({ filed: [filed], drafted: [dev] });
  assert.equal(filed.hours, 5);
  assert.equal(filed.comments, 'yesterday text');
  assert.notEqual(entries[0], filed);
});

test('a drafted row matching nothing is posted with no id — a genuine insert', () => {
  // The guard against over-broad inheritance: an id borrowed from a row that is
  // NOT being superseded would overwrite that row and delete this work.
  const { entries } = mergeWeek({ filed: [filedDev], drafted: [{ ...dev, activityId: 'act-new' }] });
  const insert = entries.find(e => e.activityId === 'act-new');
  assert.equal(insert.id, undefined);
  assert.equal(insert.timesheetId, undefined);
});

test('a filed row we keep is posted back with every field it arrived with', () => {
  // A standing guard, not a new behaviour: kept rows already survive by
  // identity. D3 adds cloning to the drafted path, and an over-broad clone —
  // or a "post only our five fields" normalisation — would silently strip
  // isBillable and activity from rows this app did not author.
  const { entries } = mergeWeek({ filed: [filedDev], drafted: [] });
  assert.equal(entries[0], filedDev);
  assert.deepEqual(entries[0], filedDev);
});

test('a drafted row carries no id when the filed row it replaces has none', () => {
  // Rows filed before ids existed, or a shape change: inheriting `undefined`
  // must not turn an update into a payload with an explicit null id.
  const { entries } = mergeWeek({ filed: [{ ...dev, hours: 5 }], drafted: [dev] });
  assert.ok(!('id' in entries[0]));
  assert.ok(!('timesheetId' in entries[0]));
});

// --- D4: a week that is not writable ------------------------------------------
// Weeks carry status, isUnlocked, submittedAt and approvedAt. Nothing consulted
// them, so a confirm would happily replace a week already submitted for
// approval — silently reopening or corrupting a record someone signed off.

test('a week with no timesheet yet is writable', () => {
  // The common case: nothing filed, [] came back, there is nothing to protect.
  assert.equal(weekWritable(null), true);
  assert.equal(weekWritable(undefined), true);
});

test('a DRAFT week is writable', () => {
  assert.equal(weekWritable({ status: 'DRAFT', isUnlocked: false }), true);
});

test('a submitted or approved week is not writable', () => {
  assert.equal(weekWritable({ status: 'SUBMITTED', isUnlocked: false }), false);
  assert.equal(weekWritable({ status: 'APPROVED', isUnlocked: false }), false);
});

test('an unlocked week is writable whatever its status', () => {
  // Unlocking is the operator's own act in Sphere360 — the one signal that a
  // non-DRAFT week is open for edits again.
  assert.equal(weekWritable({ status: 'SUBMITTED', isUnlocked: true }), true);
});

test('a status this code does not recognise fails closed', () => {
  // Refusing to write is recoverable — the operator unlocks the week and
  // retries. Writing a week we cannot classify is not: the endpoint replaces
  // it. Every unknown must therefore land on the refusing side, including a
  // case mismatch and an absent status.
  assert.equal(weekWritable({ status: 'PENDING_APPROVAL', isUnlocked: false }), false);
  assert.equal(weekWritable({ status: 'draft', isUnlocked: false }), false);
  assert.equal(weekWritable({}), false);
});

test('only a real boolean true unlocks a week', () => {
  // JSON from another system: 'false' is a truthy string, and a loose check
  // would read a LOCKED week as unlocked and write it.
  assert.equal(weekWritable({ status: 'SUBMITTED', isUnlocked: 'false' }), false);
  assert.equal(weekWritable({ status: 'SUBMITTED', isUnlocked: 1 }), false);
});
