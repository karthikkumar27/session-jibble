const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseEvent, fileEntrypoint, hasInteractiveMarkers, isBillable,
  INFERRED_INTERACTIVE, MALFORMED,
} = require('../lib/transcript');

// A real record shape, captured from ~/.claude/projects/ (message body dropped).
const row = (over = {}) => JSON.stringify({
  type: 'user',
  timestamp: '2026-08-15T14:05:33.803Z',
  sessionId: 'dde99e04-07cb-4c89-b58b-61a6e5fcab9c',
  uuid: 'd54ca9a7-c1d8-4327-b9ba-a26421c6190d',
  cwd: '/Users/dev/gitlab-projects/user-management-web',
  gitBranch: 'feat/crew-profile-rbac-seeding',
  entrypoint: 'cli',
  isSidechain: false,
  ...over,
});

test('parseEvent normalises a user row', () => {
  const e = parseEvent(row());
  assert.equal(e.uuid, 'd54ca9a7-c1d8-4327-b9ba-a26421c6190d');
  assert.equal(e.sessionId, 'dde99e04-07cb-4c89-b58b-61a6e5fcab9c');
  assert.equal(e.type, 'user');
  assert.equal(e.cwd, '/Users/dev/gitlab-projects/user-management-web');
  assert.equal(e.gitBranch, 'feat/crew-profile-rbac-seeding');
  assert.equal(e.entrypoint, 'cli');
  assert.equal(e.isSidechain, false);
});

test('parseEvent converts the ISO timestamp to epoch ms', () => {
  assert.equal(parseEvent(row()).ts, Date.parse('2026-08-15T14:05:33.803Z'));
});

test('parseEvent returns null for a legitimate non-activity row', () => {
  assert.equal(parseEvent(''), null);
  assert.equal(parseEvent('   '), null);
  assert.equal(parseEvent(row({ type: 'ai-title' })), null);
  assert.equal(parseEvent(row({ type: 'file-history-snapshot' })), null);
  assert.equal(parseEvent(row({ type: 'summary' })), null);
});

// I2: a corrupt line used to be indistinguishable from an ai-title row — both
// returned null, both were dropped, and the offset advanced past them forever.
test('parseEvent reports a corrupt line as MALFORMED, not as a metadata row', () => {
  assert.equal(parseEvent('{not json'), MALFORMED);
  assert.equal(parseEvent('null'), MALFORMED);
  assert.equal(parseEvent('42'), MALFORMED);
  assert.equal(parseEvent('"a string"'), MALFORMED);
});

test('parseEvent reports an unusable ACTIVITY row as MALFORMED', () => {
  assert.equal(parseEvent(row({ timestamp: undefined })), MALFORMED);
  assert.equal(parseEvent(row({ timestamp: 'not-a-date' })), MALFORMED);
  assert.equal(parseEvent(row({ uuid: undefined })), MALFORMED);
  assert.equal(parseEvent(row({ sessionId: undefined })), MALFORMED);
});

test('parseEvent defaults optional string fields rather than dropping the row', () => {
  const e = parseEvent(row({ cwd: undefined, gitBranch: undefined }));
  assert.equal(e.cwd, '');
  assert.equal(e.gitBranch, '');
});

test('parseEvent reports a missing entrypoint as null, not a guess', () => {
  assert.equal(parseEvent(row({ entrypoint: undefined })).entrypoint, null);
  assert.equal(parseEvent(row({ entrypoint: '' })).entrypoint, null);
});

test('parseEvent coerces isSidechain to a strict boolean', () => {
  assert.equal(parseEvent(row({ isSidechain: true })).isSidechain, true);
  assert.equal(parseEvent(row({ isSidechain: null })).isSidechain, false);
  assert.equal(parseEvent(row({ isSidechain: undefined })).isSidechain, false);
});

test('fileEntrypoint takes the first stated value', () => {
  assert.equal(fileEntrypoint([row({ entrypoint: undefined }), row({ entrypoint: 'sdk-py' })]), 'sdk-py');
});

test('fileEntrypoint returns null when no row states one', () => {
  assert.equal(fileEntrypoint([row({ entrypoint: undefined })]), null);
  assert.equal(fileEntrypoint([]), null);
});

test('fileEntrypoint ignores lines it cannot decode', () => {
  assert.equal(fileEntrypoint(['{not json', '', '   ', row()]), 'cli');
});

// C1(a): the real transcript f9236b7c-… states entrypoint only on system and
// attachment rows and has no user/assistant rows at all. Reading it through
// parseEvent's user/assistant filter left it permanently unclassified.
test('C1a: fileEntrypoint finds an entrypoint stated on a NON-activity row', () => {
  const lines = [
    JSON.stringify({ type: 'system', timestamp: '2026-08-15T14:05:33.803Z', entrypoint: 'cli' }),
    JSON.stringify({ type: 'mode', mode: 'default' }),
    JSON.stringify({ type: 'last-prompt', prompt: 'hi' }),
  ];
  assert.equal(fileEntrypoint(lines), 'cli');
});

test('C1a: an sdk entrypoint on a non-activity row still excludes the file', () => {
  const lines = [JSON.stringify({ type: 'system', entrypoint: 'sdk-cli' })];
  assert.equal(fileEntrypoint(lines), 'sdk-cli');
  assert.equal(isBillable(fileEntrypoint(lines)), false);
});

// C1(b): transcripts that state no entrypoint anywhere but carry the user's own
// non-sidechain turns are real human work, not "non-interactive".
test('C1b: hasInteractiveMarkers detects an external non-sidechain turn', () => {
  assert.equal(hasInteractiveMarkers([row({ entrypoint: undefined, userType: 'external' })]), true);
});

test('C1b: hasInteractiveMarkers detects last-prompt and permission-mode rows', () => {
  assert.equal(hasInteractiveMarkers([JSON.stringify({ type: 'last-prompt' })]), true);
  assert.equal(hasInteractiveMarkers([JSON.stringify({ type: 'permission-mode', mode: 'plan' })]), true);
});

test('C1b: a sidechain-only external row is not a human-presence signal', () => {
  const lines = [row({ entrypoint: undefined, userType: 'external', isSidechain: true })];
  assert.equal(hasInteractiveMarkers(lines), false);
});

test('C1b: hasInteractiveMarkers is false for rows with no human signal', () => {
  assert.equal(hasInteractiveMarkers([row({ entrypoint: undefined, userType: undefined })]), false);
  assert.equal(hasInteractiveMarkers([JSON.stringify({ type: 'summary', summary: 's' })]), false);
  assert.equal(hasInteractiveMarkers(['{not json', '']), false);
  assert.equal(hasInteractiveMarkers([]), false);
});

test('interactive work is billable and sdk runs never are', () => {
  assert.equal(isBillable('cli'), true);
  assert.equal(isBillable(INFERRED_INTERACTIVE), true);
  assert.equal(isBillable('sdk-cli'), false);
  assert.equal(isBillable('sdk-py'), false);
  assert.equal(isBillable(null), false);
  assert.equal(isBillable(undefined), false);
});
