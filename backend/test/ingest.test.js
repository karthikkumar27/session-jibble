const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger } = require('../lib/ledger');
const { readTail, listTranscripts, ingest } = require('../lib/ingest');

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `jibble-${tag}-`));

let seq = 0;
const row = (over = {}) => `${JSON.stringify({
  type: 'user',
  timestamp: '2026-08-15T14:05:33.803Z',
  sessionId: 's1',
  uuid: `u${++seq}`,
  cwd: '/repo',
  gitBranch: 'main',
  entrypoint: 'cli',
  isSidechain: false,
  ...over,
})}\n`;

// Builds ~/.claude/projects/<dir>/<session>.jsonl style layout.
function project(root, dirName, fileName, body) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, body);
  return file;
}

test('readTail returns complete lines and the offset past them', () => {
  const dir = tmpdir('tail');
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, 'one\ntwo\n');
  const out = readTail(file, 0);
  assert.deepEqual(out.lines, ['one', 'two']);
  assert.equal(out.nextOffset, 8);
});

test('readTail leaves a partial trailing line unconsumed', () => {
  const dir = tmpdir('tail');
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, 'one\ntw');
  const out = readTail(file, 0);
  assert.deepEqual(out.lines, ['one']);
  assert.equal(out.nextOffset, 4);

  // The partial line completes on the next run and is read exactly once.
  fs.appendFileSync(file, 'o\n');
  const next = readTail(file, out.nextOffset);
  assert.deepEqual(next.lines, ['two']);
});

test('readTail reads only bytes added since the given offset', () => {
  const dir = tmpdir('tail');
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, 'one\n');
  const first = readTail(file, 0);
  fs.appendFileSync(file, 'two\n');
  const second = readTail(file, first.nextOffset);
  assert.deepEqual(second.lines, ['two']);
});

test('readTail re-reads from zero when the file shrank', () => {
  const dir = tmpdir('tail');
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, 'one\ntwo\n');
  fs.writeFileSync(file, 'new\n');
  const out = readTail(file, 8);
  assert.deepEqual(out.lines, ['new']);
});

test('readTail handles multi-byte characters without splitting them', () => {
  const dir = tmpdir('tail');
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, '日本語\n');
  const first = readTail(file, 0);
  assert.deepEqual(first.lines, ['日本語']);
  fs.appendFileSync(file, 'ok\n');
  assert.deepEqual(readTail(file, first.nextOffset).lines, ['ok']);
});

test('listTranscripts finds jsonl files one level down and ignores others', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 's1.jsonl', row());
  project(root, '-Users-dev-b', 's2.jsonl', row());
  project(root, '-Users-dev-b', 'notes.txt', 'ignore me');
  fs.writeFileSync(path.join(root, 'stray.jsonl'), row());

  const found = listTranscripts(root).map(f => path.basename(f));
  assert.deepEqual(found.sort(), ['s1.jsonl', 's2.jsonl']);
});

test('listTranscripts returns empty for a missing directory', () => {
  assert.deepEqual(listTranscripts(path.join(tmpdir('projects'), 'nope')), []);
});

test('ingest stores cli events and skips sdk runs entirely', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row() + row());
  project(root, '-Users-dev-b', 'sdk.jsonl', row({ entrypoint: 'sdk-py' }));

  const led = createLedger(tmpdir('ledger'));
  const summary = ingest(led, root);

  assert.equal(summary.eventsAppended, 2);
  assert.equal(summary.skippedNonBillable, 1);
  assert.equal(led.size(), 2);
});

test('ingest excludes files that state no entrypoint rather than guessing', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'unknown.jsonl', row({ entrypoint: undefined }));

  const led = createLedger(tmpdir('ledger'));
  assert.equal(ingest(led, root).eventsAppended, 0);
});

test('ingest excludes sidechain rows from a cli transcript', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row() + row({ isSidechain: true }));

  const led = createLedger(tmpdir('ledger'));
  assert.equal(ingest(led, root).eventsAppended, 1);
});

test('a second ingest with no new data appends nothing', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row());
  const ledgerDir = tmpdir('ledger');

  assert.equal(ingest(createLedger(ledgerDir), root).eventsAppended, 1);
  assert.equal(ingest(createLedger(ledgerDir), root).eventsAppended, 0);
});

test('ingest picks up only rows appended since the previous run', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'cli.jsonl', row());
  const ledgerDir = tmpdir('ledger');

  ingest(createLedger(ledgerDir), root);
  fs.appendFileSync(file, row());

  const summary = ingest(createLedger(ledgerDir), root);
  assert.equal(summary.eventsAppended, 1);
  assert.equal(createLedger(ledgerDir).load(), 2);
});

test('ingest remembers a cached entrypoint so later tails classify correctly', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'cli.jsonl', row());
  const ledgerDir = tmpdir('ledger');
  ingest(createLedger(ledgerDir), root);

  // Later rows in a real transcript may omit entrypoint; the cached value must
  // still classify this file as billable.
  fs.appendFileSync(file, row({ entrypoint: undefined }));
  assert.equal(ingest(createLedger(ledgerDir), root).eventsAppended, 1);
});

test('ingest records the stored offset and entrypoint per file', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'cli.jsonl', row());
  const ledgerDir = tmpdir('ledger');
  ingest(createLedger(ledgerDir), root);

  const entry = createLedger(ledgerDir).readState().files[file];
  assert.equal(entry.entrypoint, 'cli');
  assert.equal(entry.offset, fs.statSync(file).size);
});

test('ingest counts files by entrypoint', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row());
  project(root, '-Users-dev-b', 'sdk.jsonl', row({ entrypoint: 'sdk-cli' }));
  project(root, '-Users-dev-c', 'none.jsonl', row({ entrypoint: undefined }));

  const summary = ingest(createLedger(tmpdir('ledger')), root);
  assert.equal(summary.byEntrypoint.cli, 1);
  assert.equal(summary.byEntrypoint['sdk-cli'], 1);
  assert.equal(summary.byEntrypoint.unknown, 1);
  assert.equal(summary.filesScanned, 3);
});

test('ingest stores only the fields the duration engine needs', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row());
  const ledgerDir = tmpdir('ledger');
  ingest(createLedger(ledgerDir), root);

  const line = fs.readFileSync(path.join(ledgerDir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean)[0];
  assert.deepEqual(Object.keys(JSON.parse(line)).sort(),
    ['cwd', 'gitBranch', 'sessionId', 'ts', 'type', 'uuid']);
});

test('F1: unclassified events are re-read after they classify', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'unknown.jsonl', row({ entrypoint: undefined }));
  const ledgerDir = tmpdir('ledger');

  // First run: unclassified event is skipped, file not added to state
  const first = ingest(createLedger(ledgerDir), root);
  assert.equal(first.eventsAppended, 0);
  assert.equal(createLedger(ledgerDir).readState().files[file], undefined);

  // Append a cli event
  fs.appendFileSync(file, row());

  // Second run: earlier unclassified event is re-read and ingested
  const second = ingest(createLedger(ledgerDir), root);
  assert.equal(second.eventsAppended, 2);
  assert.equal(createLedger(ledgerDir).load(), 2);
});

test('F2: invalid UTF-8 before final newline yields correct nextOffset', () => {
  const dir = tmpdir('tail');
  const file = path.join(dir, 't.jsonl');
  // Write a line, then append invalid UTF-8 bytes before the newline
  const validLine = 'valid\n';
  const invalidBytes = Buffer.concat([
    Buffer.from('partial'),
    Buffer.from([0xFF, 0xFE]), // invalid UTF-8
    Buffer.from('\n'),
  ]);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from(validLine),
    invalidBytes,
  ]));

  const first = readTail(file, 0);
  // Should get the valid line and the partial (even though invalid UTF-8)
  assert.equal(first.lines.length, 2);
  // nextOffset should point exactly to the byte after the second newline
  const fileSize = fs.statSync(file).size;
  assert.equal(first.nextOffset, fileSize);

  // Appending to that offset should work correctly
  fs.appendFileSync(file, 'next\n');
  const second = readTail(file, first.nextOffset);
  assert.deepEqual(second.lines, ['next']);
});

test('F3: second ingest over sdk file skips without parsing', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'sdk.jsonl', row({ entrypoint: 'sdk-py' }));
  const ledgerDir = tmpdir('ledger');

  // First ingest: marks file as sdk-py
  ingest(createLedger(ledgerDir), root);

  // Append more data
  fs.appendFileSync(file, row({ entrypoint: 'sdk-py' }));

  // Second ingest: should skip parsing and just update offset
  const summary = ingest(createLedger(ledgerDir), root);
  assert.equal(summary.eventsAppended, 0);
  assert.equal(summary.skippedNonBillable, 1);
  assert.equal(createLedger(ledgerDir).readState().files[file].offset, fs.statSync(file).size);
});

test('F4: errors counter increments on file stat failures', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row());
  const ledgerDir = tmpdir('ledger');

  // Try to ingest from a non-existent directory
  const summary = ingest(createLedger(ledgerDir), '/nonexistent/path');
  assert.equal(summary.errors, 1);
  assert.equal(summary.filesScanned, 0);
});
