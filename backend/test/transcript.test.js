const { test } = require('node:test');
const assert = require('node:assert');
const { parseEvent, fileEntrypoint, isBillable } = require('../lib/transcript');

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

test('parseEvent rejects rows that cannot be counted', () => {
  assert.equal(parseEvent(''), null);
  assert.equal(parseEvent('   '), null);
  assert.equal(parseEvent('{not json'), null);
  assert.equal(parseEvent('null'), null);
  assert.equal(parseEvent(row({ type: 'ai-title' })), null);
  assert.equal(parseEvent(row({ type: 'file-history-snapshot' })), null);
  assert.equal(parseEvent(row({ timestamp: undefined })), null);
  assert.equal(parseEvent(row({ timestamp: 'not-a-date' })), null);
  assert.equal(parseEvent(row({ uuid: undefined })), null);
  assert.equal(parseEvent(row({ sessionId: undefined })), null);
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
  const events = [
    parseEvent(row({ entrypoint: undefined })),
    parseEvent(row({ entrypoint: 'sdk-py' })),
  ];
  assert.equal(fileEntrypoint(events), 'sdk-py');
});

test('fileEntrypoint returns null when no row states one', () => {
  assert.equal(fileEntrypoint([parseEvent(row({ entrypoint: undefined }))]), null);
  assert.equal(fileEntrypoint([]), null);
});

test('only interactive cli work is billable', () => {
  assert.equal(isBillable('cli'), true);
  assert.equal(isBillable('sdk-cli'), false);
  assert.equal(isBillable('sdk-py'), false);
  assert.equal(isBillable(null), false);
  assert.equal(isBillable(undefined), false);
});
