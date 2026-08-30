const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_MAPPING, validateMapping, loadMapping, saveMapping, resolveProject,
  isHoliday, resolveDailyMinimum, toPositiveFiniteNumber, beforeCutover,
} = require('../lib/sphere360/mapping');

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sj-ts-')), 'timesheet.json');

const valid = {
  version: 1,
  resourceId: '89f714e1-b2c2-4002-b197-577ef5399683',
  projects: [{
    label: 'SkyIQ / Development',
    roots: ['~/ai-research', '~/skyiq-reports'],
    projectId: '1804361',
    activityId: '5dbfdeb3-f41e-42c0-8410-d2d1725c1041',
  }],
  dailyMinimumHours: 8,
};

test('accepts a well-formed mapping', () => {
  const { mapping, errors } = validateMapping(valid);
  assert.deepEqual(errors, []);
  assert.equal(mapping.projects[0].projectId, '1804361');
  assert.equal(mapping.dailyMinimumHours, 8);
});

test('defaults dailyMinimumHours to 8 when absent', () => {
  const { mapping } = validateMapping({ ...valid, dailyMinimumHours: undefined });
  assert.equal(mapping.dailyMinimumHours, 8);
});

test('rejects a missing resourceId with a field path', () => {
  const { mapping, errors } = validateMapping({ ...valid, resourceId: '' });
  assert.equal(mapping, null);
  assert.equal(errors[0].path, 'resourceId');
});

test('rejects a relative root', () => {
  const { errors } = validateMapping({
    ...valid,
    projects: [{ ...valid.projects[0], roots: ['ai-research'] }],
  });
  assert.equal(errors[0].path, 'projects[0].roots[0]');
});

test('rejects a project missing its activityId', () => {
  const { errors } = validateMapping({
    ...valid,
    projects: [{ ...valid.projects[0], activityId: '' }],
  });
  assert.equal(errors[0].path, 'projects[0].activityId');
});

test('rejects the same root claimed by two projects', () => {
  // Ambiguous attribution is a mistake, and longest-prefix would silently pick one.
  const { errors } = validateMapping({
    ...valid,
    projects: [
      valid.projects[0],
      { label: 'Other', roots: ['~/ai-research'], projectId: '99', activityId: 'a' },
    ],
  });
  assert.match(errors[0].message, /also listed under/);
});

test('resolveProject picks the longest matching root', () => {
  const { mapping } = validateMapping({
    ...valid,
    projects: [
      { label: 'Broad', roots: ['/work'], projectId: '1', activityId: 'a' },
      { label: 'Narrow', roots: ['/work/skyiq'], projectId: '2', activityId: 'b' },
    ],
  });
  assert.equal(resolveProject('/work/skyiq/web', mapping).label, 'Narrow');
  assert.equal(resolveProject('/work/other', mapping).label, 'Broad');
});

test('resolveProject is segment-aware — /work/skyiqx is not inside /work/skyiq', () => {
  const { mapping } = validateMapping({
    ...valid,
    projects: [{ label: 'Narrow', roots: ['/work/skyiq'], projectId: '2', activityId: 'b' }],
  });
  assert.equal(resolveProject('/work/skyiqx', mapping), null);
});

test('resolveProject returns null for an unmapped path', () => {
  const { mapping } = validateMapping(valid);
  assert.equal(resolveProject('/somewhere/else', mapping), null);
});

test('loadMapping falls back to defaults with an error on a bad version', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ ...valid, version: 99 }));
  const { mapping, source, error } = loadMapping(file);
  assert.equal(source, 'defaults');
  assert.deepEqual(mapping, DEFAULT_MAPPING);
  assert.match(error, /version/);
});

test('saveMapping then loadMapping round-trips', () => {
  const file = tmpFile();
  const { mapping } = validateMapping(valid);
  saveMapping(mapping, file);
  assert.deepEqual(loadMapping(file).mapping, mapping);
});

test('drops unknown top-level keys on write', () => {
  const { mapping } = validateMapping({ ...valid, somethingElse: 1 });
  assert.equal(mapping.somethingElse, undefined);
});

// --- holidays --------------------------------------------------------------
// A Mon-Fri public holiday is not a working day, but until now the mapping
// had no way to say so. There is no holiday endpoint (all four probed paths
// 404), so the list is hand-configured here.

// Consecutive calendar days from 2026-01-01, built the same way week.js does
// its own UTC arithmetic — a boundary test for the 100-entry cap needs many
// unique valid dates, not a hand-typed list.
const nthDateOf2026 = (n) => {
  const ms = Date.UTC(2026, 0, 1) + n * 86_400_000;
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

test('accepts a well-formed mapping with holidays', () => {
  const { mapping, errors } = validateMapping({ ...valid, holidays: ['2026-01-01', '2026-05-01'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(mapping.holidays, ['2026-01-01', '2026-05-01']);
});

test('defaults holidays to [] when absent', () => {
  const { mapping } = validateMapping(valid);
  assert.deepEqual(mapping.holidays, []);
});

test('an explicitly empty holidays array is valid and means none configured', () => {
  const { mapping, errors } = validateMapping({ ...valid, holidays: [] });
  assert.deepEqual(errors, []);
  assert.deepEqual(mapping.holidays, []);
});

test('rejects a non-array holidays with a field path', () => {
  const { mapping, errors } = validateMapping({ ...valid, holidays: 'not-an-array' });
  assert.equal(mapping, null);
  assert.equal(errors[0].path, 'holidays');
});

test('rejects a calendar-invalid holiday with an indexed field path', () => {
  // The exact case from the design doc: a Mon-Fri holiday miscoded to an
  // impossible date must be refused, not silently normalised to Mar 2.
  const holidays = ['2026-01-01', '2026-02-14', '2026-03-01', '2026-02-30'];
  const { mapping, errors } = validateMapping({ ...valid, holidays });
  assert.equal(mapping, null);
  assert.equal(errors[0].path, 'holidays[3]');
});

test('rejects a malformed holiday date shape with an indexed field path', () => {
  const { errors } = validateMapping({ ...valid, holidays: ['08/26/2026'] });
  assert.equal(errors[0].path, 'holidays[0]');
});

test('dedupes duplicate holidays silently, without an error', () => {
  const { mapping, errors } = validateMapping({
    ...valid,
    holidays: ['2026-01-01', '2026-01-01', '2026-05-01'],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(mapping.holidays, ['2026-01-01', '2026-05-01']);
});

test('accepts exactly 100 holidays', () => {
  const holidays = Array.from({ length: 100 }, (_, i) => nthDateOf2026(i));
  const { mapping, errors } = validateMapping({ ...valid, holidays });
  assert.deepEqual(errors, []);
  assert.equal(mapping.holidays.length, 100);
});

test('rejects more than 100 holidays', () => {
  const holidays = Array.from({ length: 101 }, (_, i) => nthDateOf2026(i));
  const { mapping, errors } = validateMapping({ ...valid, holidays });
  assert.equal(mapping, null);
  assert.equal(errors[0].path, 'holidays');
});

test('validates holidays after dailyMinimumHours and before the project loop', () => {
  // THE order proof: with all three broken at once, errors[0] must stay
  // dailyMinimumHours (existing tests assert that position), holidays comes
  // next, and per-project errors come last — exactly the placement the task
  // requires, not just "holidays errors exist somewhere".
  const { errors } = validateMapping({
    ...valid,
    dailyMinimumHours: -1,
    holidays: ['not-a-date'],
    projects: [{ ...valid.projects[0], activityId: '' }],
  });
  assert.equal(errors[0].path, 'dailyMinimumHours');
  assert.equal(errors[1].path, 'holidays[0]');
  assert.equal(errors[2].path, 'projects[0].activityId');
});

// --- syncFrom / the Jibble cutover -------------------------------------------
// Jibble was the operator's timesheet of record through 2026-08-25 and
// Sphere360 from 2026-08-26 — a day they entered by hand — so nothing may be
// drafted or written before 2026-08-27. Sphere360 itself cannot express this:
// it tracks status per WEEK, and the week of 24 Aug is DRAFT and writable, so
// its own guard would happily let 7.42h of an already-reconciled Jibble period
// be written into it.

test('accepts a well-formed syncFrom', () => {
  const { mapping, errors } = validateMapping({ ...valid, syncFrom: '2026-08-27' });
  assert.deepEqual(errors, []);
  assert.equal(mapping.syncFrom, '2026-08-27');
});

test('an absent syncFrom is valid and means no cutover at all', () => {
  // Not defaulted to today, to the epoch, or to anything else: an operator who
  // has never set a cutover must not silently acquire one they did not ask for.
  const { mapping, errors } = validateMapping(valid);
  assert.deepEqual(errors, []);
  assert.equal(mapping.syncFrom, undefined);
  assert.equal(beforeCutover('1999-01-01', mapping), false);
});

test('rejects a calendar-invalid syncFrom with the syncFrom field path', () => {
  // week.js's own shape-AND-calendar check, reused rather than re-implemented:
  // 2026-02-30 must be refused, not normalised to Mar 2 — which would move the
  // cutover two days and reopen part of the closed Jibble period.
  const { mapping, errors } = validateMapping({ ...valid, syncFrom: '2026-02-30' });
  assert.equal(mapping, null);
  assert.equal(errors[0].path, 'syncFrom');
});

test('rejects a malformed syncFrom with the syncFrom field path', () => {
  for (const bad of ['08/27/2026', '2026-8-27', '', 27, true, null]) {
    const { mapping, errors } = validateMapping({ ...valid, syncFrom: bad });
    assert.equal(mapping, null, `accepted ${JSON.stringify(bad)}`);
    assert.equal(errors[0].path, 'syncFrom', `wrong path for ${JSON.stringify(bad)}`);
  }
});

test('validates syncFrom after holidays and before the project loop', () => {
  // The order proof, extended. Several existing tests assert errors[0].path,
  // so a new check inserted in the wrong place silently breaks them; with all
  // four fields broken at once the positions are pinned here explicitly.
  const { errors } = validateMapping({
    ...valid,
    dailyMinimumHours: -1,
    holidays: ['not-a-date'],
    syncFrom: '2026-02-30',
    projects: [{ ...valid.projects[0], activityId: '' }],
  });
  assert.equal(errors[0].path, 'dailyMinimumHours');
  assert.equal(errors[1].path, 'holidays[0]');
  assert.equal(errors[2].path, 'syncFrom');
  assert.equal(errors[3].path, 'projects[0].activityId');
});

test('saveMapping then loadMapping round-trips a syncFrom', () => {
  const file = tmpFile();
  const { mapping } = validateMapping({ ...valid, syncFrom: '2026-08-27' });
  saveMapping(mapping, file);
  assert.equal(loadMapping(file).mapping.syncFrom, '2026-08-27');
});

test('beforeCutover is true before syncFrom and false from the cutover onward', () => {
  const { mapping } = validateMapping({ ...valid, syncFrom: '2026-08-27' });
  assert.equal(beforeCutover('2026-08-24', mapping), true);    // Jibble's period
  assert.equal(beforeCutover('2026-08-25', mapping), true);    // Jibble's last day
  assert.equal(beforeCutover('2026-08-26', mapping), true);    // hand-entered
  assert.equal(beforeCutover('2026-08-27', mapping), false);   // the cutover is INCLUDED
  assert.equal(beforeCutover('2026-08-28', mapping), false);
});

test('beforeCutover orders across a year boundary', () => {
  // A plain YYYY-MM-DD string compare IS calendar order. This fails loudly if
  // anyone rewrites it as a day-of-month or month-of-year comparison.
  const { mapping } = validateMapping({ ...valid, syncFrom: '2027-01-01' });
  assert.equal(beforeCutover('2026-12-31', mapping), true);
  assert.equal(beforeCutover('2027-01-02', mapping), false);
});

test('beforeCutover is false for every date when no syncFrom is configured', () => {
  const { mapping } = validateMapping(valid);
  for (const d of ['1970-01-01', '2026-08-24', '2999-12-31']) {
    assert.equal(beforeCutover(d, mapping), false, `excluded ${d}`);
  }
});

// --- isHoliday ---------------------------------------------------------------

test('isHoliday is true for a configured holiday date', () => {
  const { mapping } = validateMapping({ ...valid, holidays: ['2026-08-31'] });
  assert.equal(isHoliday('2026-08-31', mapping), true);
});

test('isHoliday is false for a date not in the holiday list', () => {
  const { mapping } = validateMapping({ ...valid, holidays: ['2026-08-31'] });
  assert.equal(isHoliday('2026-09-01', mapping), false);
});

test('isHoliday is false when no holidays are configured', () => {
  const { mapping } = validateMapping(valid);
  assert.equal(isHoliday('2026-08-31', mapping), false);
});

// --- resolveDailyMinimum ------------------------------------------------------
// Sphere360's own weeklyCapacityHours (observed 40 -> 8h/day) beats the
// mapping's configured fallback whenever the week carries a resource; a week
// with no timesheet yet (client.js returns week: null) carries none.

test('resolveDailyMinimum prefers Sphere360 weeklyCapacityHours over the config value', () => {
  // dailyMinimumHours is deliberately NOT 8, so a result of 8 can only have
  // come from 40 / 5, never from silently falling through to config.
  const { mapping } = validateMapping({ ...valid, dailyMinimumHours: 6 });
  const week = { resource: { weeklyCapacityHours: 40 } };
  const result = resolveDailyMinimum(mapping, week);
  assert.equal(result.hours, 8);
  assert.equal(result.source, 'sphere360');
});

test('resolveDailyMinimum falls back to the config value when week is null', () => {
  const { mapping } = validateMapping({ ...valid, dailyMinimumHours: 7 });
  const result = resolveDailyMinimum(mapping, null);
  assert.equal(result.hours, 7);
  assert.equal(result.source, 'config');
});

test('resolveDailyMinimum falls back to the config value when the week has no resource', () => {
  const { mapping } = validateMapping({ ...valid, dailyMinimumHours: 7 });
  const result = resolveDailyMinimum(mapping, {});
  assert.equal(result.hours, 7);
  assert.equal(result.source, 'config');
});

test('resolveDailyMinimum falls back to the config value when weeklyCapacityHours is not a usable positive number', () => {
  const { mapping } = validateMapping({ ...valid, dailyMinimumHours: 7 });
  for (const bad of [0, -5, 'forty', null, undefined, NaN]) {
    const result = resolveDailyMinimum(mapping, { resource: { weeklyCapacityHours: bad } });
    assert.equal(result.source, 'config', `accepted ${JSON.stringify(bad)}`);
    assert.equal(result.hours, 7);
  }
});

// Sphere360 serialises weeklyCapacityHours as a STRING on the live API
// ("40", typeof string) — verified against the live endpoint. A guard of
// `typeof capacity === 'number'` rejects that real value outright and falls
// through to the config fallback, which only looks right because 40 / 5 = 8
// happens to match the default. Anyone whose capacity is not 40 would get a
// silently wrong number with the old guard.
test('resolveDailyMinimum accepts weeklyCapacityHours sent as a numeric string, as Sphere360 sends it live', () => {
  const { mapping } = validateMapping({ ...valid, dailyMinimumHours: 6 });
  const week = { resource: { weeklyCapacityHours: '40' } };
  const result = resolveDailyMinimum(mapping, week);
  assert.equal(result.source, 'sphere360');
  assert.equal(result.hours, 8);
});

// --- toPositiveFiniteNumber ---------------------------------------------------
// The shared coercion behind resolveDailyMinimum (and progress.js's
// targetUtilization read). Tested directly so its contract is pinned
// independent of either call site.

test('toPositiveFiniteNumber accepts a number or a numeric string', () => {
  assert.equal(toPositiveFiniteNumber(40), 40);
  assert.equal(toPositiveFiniteNumber('40'), 40);
});

test('toPositiveFiniteNumber rejects everything that is not a usable positive number', () => {
  for (const bad of [null, undefined, '', 'abc', NaN, Infinity, -Infinity, 0, -1, -5]) {
    assert.equal(toPositiveFiniteNumber(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});
