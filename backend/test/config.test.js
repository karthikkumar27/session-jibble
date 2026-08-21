const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_CONFIG, validateConfig, loadConfig, saveConfig, isUnconfigured,
} = require('../lib/config');

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sj-cfg-')), 'config.json');

const valid = {
  version: 1,
  work:    { roots: ['~/gitlab-projects'], contains: ['skyiq'] },
  nonWork: { roots: ['~/side'], contains: [] },
};

test('accepts a well-formed config', () => {
  const { config, errors } = validateConfig(valid);
  assert.deepEqual(errors, []);
  assert.deepEqual(config.work.roots, ['~/gitlab-projects']);
  assert.equal(config.version, 1);
});

test('accepts posix, drive, UNC and ~ roots', () => {
  const { errors } = validateConfig({
    version: 1,
    work: { roots: ['/srv/work', 'C:\\work', 'C:/work2', '\\\\server\\share', '~/w'], contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.deepEqual(errors, []);
});

test('rejects a relative root with a field path', () => {
  const { config, errors } = validateConfig({
    version: 1,
    work: { roots: ['projects/thing'], contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.equal(config, null);
  assert.equal(errors[0].path, 'work.roots[0]');
});

test('rejects an empty-string entry', () => {
  const { errors } = validateConfig({
    version: 1,
    work: { roots: ['   '], contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.equal(errors[0].path, 'work.roots[0]');
});

test('rejects the same root in both lists', () => {
  const { config, errors } = validateConfig({
    version: 1,
    work: { roots: ['~/shared'], contains: [] },
    nonWork: { roots: ['~/shared'], contains: [] },
  });
  assert.equal(config, null);
  assert.equal(errors[0].path, 'nonWork.roots[0]');
});

test('dedupes within a list without erroring', () => {
  const { config, errors } = validateConfig({
    version: 1,
    work: { roots: ['~/w', '~/w/'], contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.deepEqual(errors, []);
  assert.equal(config.work.roots.length, 1);
});

test('rejects a list over 200 entries', () => {
  const { errors } = validateConfig({
    version: 1,
    work: { roots: Array.from({ length: 201 }, (_, i) => `/r${i}`), contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.equal(errors[0].path, 'work.roots');
});

test('missing file yields defaults, not an error', () => {
  const r = loadConfig(path.join(os.tmpdir(), 'sj-does-not-exist.json'));
  assert.equal(r.source, 'defaults');
  assert.equal(r.error, null);
  assert.deepEqual(r.config, DEFAULT_CONFIG);
});

test('malformed JSON yields defaults with a surfaced error', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not json');
  const r = loadConfig(f);
  assert.equal(r.source, 'defaults');
  assert.match(r.error, /parse/i);
});

test('unknown version yields defaults with a surfaced error', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ ...valid, version: 99 }));
  const r = loadConfig(f);
  assert.equal(r.source, 'defaults');
  assert.match(r.error, /version/i);
});

test('save then load round-trips and drops unknown keys', () => {
  const f = tmpFile();
  saveConfig({ ...valid, bogus: true }, f);
  const r = loadConfig(f);
  assert.equal(r.source, 'file');
  assert.equal(r.error, null);
  assert.equal(r.config.bogus, undefined);
  assert.deepEqual(r.config.work.contains, ['skyiq']);
});

test('save leaves no temp file behind', () => {
  const f = tmpFile();
  saveConfig(valid, f);
  assert.equal(fs.existsSync(`${f}.tmp`), false);
});

test('isUnconfigured is true only when all four lists are empty', () => {
  assert.equal(isUnconfigured(DEFAULT_CONFIG), true);
  assert.equal(isUnconfigured(valid), false);
  assert.equal(isUnconfigured({
    version: 1, work: { roots: [], contains: ['x'] }, nonWork: { roots: [], contains: [] },
  }), false);
});
