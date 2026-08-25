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
  assert.equal(summary.filesExcludedSdk, 1);
  assert.equal(led.size(), 2);
});

test('ingest excludes files with no entrypoint AND no sign of a human', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'unknown.jsonl', row({ entrypoint: undefined, userType: undefined }));

  const led = createLedger(tmpdir('ledger'));
  const summary = ingest(led, root);
  assert.equal(summary.eventsAppended, 0);
  assert.equal(summary.filesUnclassified, 1);
});

// I3: capture stores raw evidence. Whether subagent chatter counts toward a
// duration is the duration engine's call — dropping the rows here would destroy
// evidence that cannot be recovered after the transcript expires.
test('I3: ingest STORES sidechain rows, tagged, rather than discarding them', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row() + row({ isSidechain: true }));

  const ledgerDir = tmpdir('ledger');
  assert.equal(ingest(createLedger(ledgerDir), root).eventsAppended, 2);

  const stored = fs.readFileSync(path.join(ledgerDir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(stored.map(e => e.isSidechain), [false, true]);
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
  fs.appendFileSync(file, row({ entrypoint: undefined, userType: undefined }));
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
  project(root, '-Users-dev-c', 'none.jsonl', row({ entrypoint: undefined, userType: undefined }));

  const summary = ingest(createLedger(tmpdir('ledger')), root);
  assert.equal(summary.byEntrypoint.cli, 1);
  assert.equal(summary.byEntrypoint['sdk-cli'], 1);
  assert.equal(summary.byEntrypoint.unknown, 1);
  assert.equal(summary.filesScanned, 3);
});

// A file counted under no key makes the summary silently under-report: the
// operator's only evidence of a complete capture stops adding up.
test('byEntrypoint totals reconcile with filesScanned, zero-byte files included', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row());
  project(root, '-Users-dev-b', 'sdk.jsonl', row({ entrypoint: 'sdk-py' }));
  project(root, '-Users-dev-c', 'empty.jsonl', '');
  project(root, '-Users-dev-d', 'partial.jsonl', '{"type":"user"');   // no newline yet

  const summary = ingest(createLedger(tmpdir('ledger')), root);
  const totalled = Object.values(summary.byEntrypoint).reduce((a, b) => a + b, 0);
  assert.equal(summary.filesScanned, 4);
  assert.equal(totalled, summary.filesScanned);
  assert.equal(summary.byEntrypoint.unknown, 2);
});

// eventsAppended counts EVENTS; the two skip counters count FILES. Naming them
// apart is what keeps a billing summary from reading as one unit.
test('file counters and the event counter carry different units', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row() + row() + row());
  project(root, '-Users-dev-b', 'sdk.jsonl', row({ entrypoint: 'sdk-py' }) + row({ entrypoint: 'sdk-py' }));
  project(root, '-Users-dev-c', 'none.jsonl', row({ entrypoint: undefined, userType: undefined }));

  const summary = ingest(createLedger(tmpdir('ledger')), root);
  assert.equal(summary.eventsAppended, 3);      // events
  assert.equal(summary.filesExcludedSdk, 1);    // files, not the 2 sdk rows
  assert.equal(summary.filesUnclassified, 1);   // files
  assert.equal(summary.skippedNonBillable, undefined);
});

test('ingest stores only the fields the duration engine needs', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row());
  const ledgerDir = tmpdir('ledger');
  ingest(createLedger(ledgerDir), root);

  const line = fs.readFileSync(path.join(ledgerDir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean)[0];
  assert.deepEqual(Object.keys(JSON.parse(line)).sort(),
    ['cwd', 'gitBranch', 'isSidechain', 'sessionId', 'ts', 'type', 'uuid']);
});

test('F1: unclassified events are re-read after they classify', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'unknown.jsonl', row({ entrypoint: undefined, userType: undefined }));
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

// F3: this must FAIL if the non-billable fast path in ingest.js is deleted.
// The discriminator is the trailing partial line: the fast path never reads the
// file and jumps the offset to EOF, while the slow path goes through readTail,
// which refuses to consume a line with no terminating newline and therefore
// leaves the offset short of EOF (and reports no new data).
test('F3: a known-sdk file is skipped without being re-read', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'sdk.jsonl', row({ entrypoint: 'sdk-py' }));
  const ledgerDir = tmpdir('ledger');

  ingest(createLedger(ledgerDir), root);            // first run: classifies sdk-py

  // A complete row plus a row Claude Code is still mid-way through writing.
  const partial = '{"type":"user","uuid":"u-partial"';
  fs.appendFileSync(file, row({ entrypoint: 'sdk-py' }) + partial);

  const summary = ingest(createLedger(ledgerDir), root);
  assert.equal(summary.eventsAppended, 0);
  assert.equal(summary.filesExcludedSdk, 1);
  assert.equal(summary.errors, 0);                  // nothing was parsed at all
  assert.equal(summary.filesChanged, 1);

  const size = fs.statSync(file).size;
  const offset = createLedger(ledgerDir).readState().files[file].offset;
  assert.equal(offset, size);                       // whole file, partial included
  assert.notEqual(offset, size - partial.length);   // what re-parsing would give
});

// I2: a corrupt line inside a BILLABLE transcript used to be dropped exactly
// like an ai-title row, with the offset advancing past it forever.
test('I2: a malformed line in a billable transcript is counted as an error', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl', row() + '{"type":"user",BROKEN\n' + row());

  const summary = ingest(createLedger(tmpdir('ledger')), root);
  assert.equal(summary.eventsAppended, 2);   // the two intact rows still land
  assert.equal(summary.errors, 1);           // and the corrupt one is visible
});

test('I2: legitimate metadata rows are NOT counted as errors', () => {
  const root = tmpdir('projects');
  project(root, '-Users-dev-a', 'cli.jsonl',
    row() + row({ type: 'ai-title' }) + row({ type: 'file-history-snapshot' }));

  const summary = ingest(createLedger(tmpdir('ledger')), root);
  assert.equal(summary.eventsAppended, 1);
  assert.equal(summary.errors, 0);
});

// C1(a): the real f9236b7c-… transcript states entrypoint 'cli' only on system
// and attachment rows and has no user/assistant rows at all. It never
// classified, so it was re-read on every run until the transcript expired.
test('C1a: a file stating entrypoint only on non-activity rows classifies', () => {
  const root = tmpdir('projects');
  const body = [
    JSON.stringify({ type: 'system', timestamp: '2026-08-15T14:05:33.803Z', entrypoint: 'cli' }),
    JSON.stringify({ type: 'last-prompt', prompt: 'do the thing' }),
    JSON.stringify({ type: 'permission-mode', mode: 'acceptEdits' }),
  ].join('\n') + '\n';
  const file = project(root, '-Users-dev-a', 'f9236b7c.jsonl', body);
  const ledgerDir = tmpdir('ledger');

  const summary = ingest(createLedger(ledgerDir), root);
  assert.equal(summary.byEntrypoint.cli, 1);
  assert.equal(summary.filesUnclassified, 0);
  // Classified means the offset is recorded, so it stops being re-read forever.
  assert.equal(createLedger(ledgerDir).readState().files[file].offset, fs.statSync(file).size);
});

test('C1a: an sdk entrypoint on a non-activity row still excludes the file', () => {
  const root = tmpdir('projects');
  const body = JSON.stringify({ type: 'system', entrypoint: 'sdk-cli' }) + '\n'
    + row({ entrypoint: undefined, userType: 'external' });
  project(root, '-Users-dev-a', 'sdk.jsonl', body);

  const summary = ingest(createLedger(tmpdir('ledger')), root);
  assert.equal(summary.eventsAppended, 0);
  assert.equal(summary.filesExcludedSdk, 1);
  assert.equal(summary.byEntrypoint['sdk-cli'], 1);
});

// C1(b): 10 real transcripts state no entrypoint at all yet carry the user's own
// turns, in billable repos. They were reported as "non-interactive" and dropped.
test('C1b: a file with no entrypoint but human turns is captured as interactive', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'none.jsonl',
    row({ entrypoint: undefined, userType: 'external' })
    + row({ entrypoint: undefined, userType: undefined, type: 'assistant' }));
  const ledgerDir = tmpdir('ledger');

  const summary = ingest(createLedger(ledgerDir), root);
  assert.equal(summary.eventsAppended, 2);
  assert.equal(summary.filesUnclassified, 0);
  assert.equal(summary.byEntrypoint.interactive, 1);
  assert.equal(createLedger(ledgerDir).readState().files[file].entrypoint, 'interactive');
});

test('C1b: an inferred file yields to an sdk entrypoint stated in a later tail', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'none.jsonl', row({ entrypoint: undefined, userType: 'external' }));
  const ledgerDir = tmpdir('ledger');

  assert.equal(ingest(createLedger(ledgerDir), root).byEntrypoint.interactive, 1);

  fs.appendFileSync(file, row({ entrypoint: 'sdk-cli' }));
  const summary = ingest(createLedger(ledgerDir), root);
  assert.equal(summary.eventsAppended, 0);
  assert.equal(summary.byEntrypoint['sdk-cli'], 1);
  assert.equal(createLedger(ledgerDir).readState().files[file].entrypoint, 'sdk-cli');
});

test('C1b: a cached interactive classification survives a tail with no markers', () => {
  const root = tmpdir('projects');
  const file = project(root, '-Users-dev-a', 'none.jsonl', row({ entrypoint: undefined, userType: 'external' }));
  const ledgerDir = tmpdir('ledger');
  ingest(createLedger(ledgerDir), root);

  fs.appendFileSync(file, row({ entrypoint: undefined, userType: undefined, type: 'assistant' }));
  const summary = ingest(createLedger(ledgerDir), root);
  assert.equal(summary.eventsAppended, 1);
  assert.equal(summary.byEntrypoint.interactive, 1);
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
