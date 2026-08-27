const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_MAPPING, validateMapping, loadMapping, saveMapping, resolveProject,
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
