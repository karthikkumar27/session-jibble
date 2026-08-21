const { test } = require('node:test');
const assert = require('node:assert');
const { classifyProject, normalizePath } = require('../lib/categorize');

// Three option sets so both filesystem behaviours are exercised from one machine.
const LINUX = { homeDir: '/home/dev', caseSensitive: true };
const MAC   = { homeDir: '/home/dev', caseSensitive: false };
const WIN   = { homeDir: 'C:\\Users\\dev', caseSensitive: false };

// Builds a full config so classifyProject never sees undefined lists by accident.
const cfg = (work = {}, nonWork = {}) => ({
  work:    { roots: [], contains: [], ...work },
  nonWork: { roots: [], contains: [], ...nonWork },
});

test('normalizePath converts backslashes and collapses repeats', () => {
  assert.equal(normalizePath('C:\\Users\\dev\\proj', WIN), 'C:/Users/dev/proj');
  assert.equal(normalizePath('\\\\server\\share\\proj', WIN), '/server/share/proj');
});

test('normalizePath upper-cases the drive letter', () => {
  assert.equal(normalizePath('c:/work', WIN), 'C:/work');
});

test('normalizePath expands ~ with either separator', () => {
  assert.equal(normalizePath('~/work', LINUX), '/home/dev/work');
  assert.equal(normalizePath('~\\work', WIN), 'C:/Users/dev/work');
});

test('normalizePath strips a trailing separator but keeps a bare root', () => {
  assert.equal(normalizePath('~/work/', LINUX), '/home/dev/work');
  assert.equal(normalizePath('/', LINUX), '/');
});

test('root matching is segment-aware', () => {
  const c = cfg({ roots: ['~/gitlab-projects'] });
  assert.equal(classifyProject('/home/dev/gitlab-projects/api', c, LINUX), 'work');
  assert.equal(classifyProject('/home/dev/gitlab-projects-archive/api', c, LINUX), 'uncategorized');
});

test('a cwd exactly equal to a root matches it', () => {
  const c = cfg({ roots: ['~/gitlab-projects'] });
  assert.equal(classifyProject('/home/dev/gitlab-projects', c, LINUX), 'work');
});

test('longest matching root wins, so a nested exception works', () => {
  const c = cfg({ roots: ['~/gitlab-projects'] }, { roots: ['~/gitlab-projects/test-mcp'] });
  assert.equal(classifyProject('/home/dev/gitlab-projects/skyiq-web', c, LINUX), 'work');
  assert.equal(classifyProject('/home/dev/gitlab-projects/test-mcp/ticker', c, LINUX), 'nonWork');
});

test('path rules outrank name rules', () => {
  const c = cfg({ contains: ['skyiq'] }, { roots: ['~/side'] });
  assert.equal(classifyProject('/home/dev/side/skyiq-toy', c, LINUX), 'nonWork');
});

test('equal-length roots in opposing lists resolve to work', () => {
  const c = cfg({ roots: ['~/shared'] }, { roots: ['~/shared'] });
  assert.equal(classifyProject('/home/dev/shared/x', c, LINUX), 'work');
});

test('name rules are case-insensitive and separator-normalized', () => {
  const c = cfg({ contains: ['projects\\skyiq'] });
  assert.equal(classifyProject('C:\\Projects\\SkyIQ-web', c, WIN), 'work');
});

test('windows paths match regardless of separator or drive case', () => {
  const c = cfg({ roots: ['c:/work'] });
  assert.equal(classifyProject('C:\\work\\proj', c, WIN), 'work');
  assert.equal(classifyProject('C:/work/proj', c, WIN), 'work');
});

test('UNC paths match a root written in either form', () => {
  const c = cfg({ roots: ['\\\\server\\share'] });
  assert.equal(classifyProject('\\\\server\\share\\proj', c, WIN), 'work');
});

// The assertion that would otherwise regress silently.
test('casing differences match on mac/windows but not on linux', () => {
  const c = cfg({ roots: ['~/work'] });
  const cwd = '/home/dev/Work/proj';
  assert.equal(classifyProject(cwd, c, MAC), 'work');
  assert.equal(classifyProject(cwd, c, LINUX), 'uncategorized');
});

test('empty inputs are uncategorized, never a crash', () => {
  assert.equal(classifyProject('', cfg(), LINUX), 'uncategorized');
  assert.equal(classifyProject('/home/dev/x', cfg(), LINUX), 'uncategorized');
  assert.equal(classifyProject('/home/dev/x', {}, LINUX), 'uncategorized');
  assert.equal(classifyProject(undefined, cfg(), LINUX), 'uncategorized');
});
