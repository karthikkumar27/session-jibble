const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger } = require('../lib/ledger');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jibble-ledger-'));
const ev = (uuid, over = {}) => ({
  uuid, sessionId: 's1', ts: 1_000, type: 'user',
  cwd: '/repo', gitBranch: 'main', ...over,
});

test('append writes events and reports how many were written', () => {
  const led = createLedger(tmpdir());
  assert.equal(led.append([ev('a'), ev('b')]), 2);
  assert.equal(led.size(), 2);
});

test('append is idempotent by uuid within one run', () => {
  const led = createLedger(tmpdir());
  assert.equal(led.append([ev('a'), ev('a'), ev('b')]), 2);
  assert.equal(led.size(), 2);
});

test('append is idempotent across runs — a re-scan cannot inflate hours', () => {
  const dir = tmpdir();
  assert.equal(createLedger(dir).append([ev('a'), ev('b')]), 2);

  const second = createLedger(dir);
  assert.equal(second.load(), 2);
  assert.equal(second.append([ev('a'), ev('b'), ev('c')]), 1);
  assert.equal(second.size(), 3);

  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
});

test('append skips events with no uuid rather than writing them', () => {
  const led = createLedger(tmpdir());
  assert.equal(led.append([ev('a'), { sessionId: 's1' }, null]), 1);
});

test('the events file is one JSON object per line', () => {
  const dir = tmpdir();
  createLedger(dir).append([ev('a'), ev('b')]);
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).uuid, 'a');
  assert.equal(JSON.parse(lines[1]).uuid, 'b');
});

test('load survives a torn final line from an interrupted write', () => {
  const dir = tmpdir();
  createLedger(dir).append([ev('a')]);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"uuid":"b","ts":1');

  const led = createLedger(dir);
  assert.equal(led.load(), 1);
  assert.equal(led.has('a'), true);
  assert.equal(led.has('b'), false);
});

test('state round-trips and defaults when absent', () => {
  const dir = tmpdir();
  const led = createLedger(dir);
  assert.deepEqual(led.readState(), { version: 1, files: {} });

  led.writeState({ version: 1, files: { '/t.jsonl': { offset: 42, entrypoint: 'cli' } } });
  assert.deepEqual(createLedger(dir).readState().files['/t.jsonl'], { offset: 42, entrypoint: 'cli' });
});

test('readState falls back to empty when the state file is corrupt', () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ingest-state.json'), '{ broken');
  assert.deepEqual(createLedger(dir).readState(), { version: 1, files: {} });
});

test('writeState leaves no temp file behind', () => {
  const dir = tmpdir();
  const led = createLedger(dir);
  led.writeState({ version: 1, files: {} });
  assert.equal(fs.existsSync(led.statePath + '.tmp'), false);
});
