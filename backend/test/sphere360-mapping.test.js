const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_MAPPING, validateMapping, loadMapping, saveMapping, resolveProject,
  isHoliday,
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
