# Transcript Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture interactive Claude Code transcript events into a durable, append-only ledger before Claude Code's ~30-day retention deletes them.

**Architecture:** Three pure-ish layers following this repo's existing injection style. `lib/transcript.js` normalises a raw JSONL line into an event and decides billability — no `fs`, no clock, fully unit-testable. `lib/ledger.js` owns the durable store: an append-only `events.jsonl` that is idempotent by event `uuid`, plus an atomically-written `ingest-state.json` of per-file byte offsets. `lib/ingest.js` walks `~/.claude/projects/`, reads only the bytes appended since the last run, and hands new events to the ledger. A thin `bin/ingest.js` makes it runnable.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, no new dependencies.

**Spec:** `docs/billing-accuracy-plan.md`

## Global Constraints

- **Store raw events, never computed intervals.** The spec's "one record per counted interval" line is superseded by this plan. Duration rules (presence gate, gap cap, density split) land in later plans and *will* change; intervals can always be recomputed from events, but events cannot be recovered once Claude Code deletes the transcript. Ingest raw.
- **Only `entrypoint === 'cli'` is billable.** `sdk-cli` (1,062 files) and `sdk-py` (395 files) are unattended programmatic runs. Files stating no entrypoint at all (10 files) are **excluded**, not guessed — under-report rather than over-report.
- **`entrypoint` never varies within a transcript file** (verified: 0 of 1,560 files). Classification is per-file and is cached in the ingest state.
- **`Date.parse()` on the ISO `timestamp` field is correct and must not be "fixed".** CLAUDE.md forbids `toISOString()` *for date labels* because it emits UTC. Parsing an ISO-8601 instant into epoch ms is the opposite operation and is timezone-safe. No local-date strings are produced anywhere in this plan.
- **Atomic writes use temp-then-rename**, matching `lib/config.js:saveConfig`.
- **Path injection style:** default the path as a function parameter (`function f(dir = DEFAULT_DIR)`), matching `lib/config.js:loadConfig`. Do not introduce options-object injection.
- Tests run with `npm test --prefix backend` (`node --test test/*.test.js`).
- Existing baseline must hold: 27/27 backend tests passing before and after.

---

### Task 1: Event normalisation (`lib/transcript.js`)

**Files:**
- Create: `backend/lib/transcript.js`
- Test: `backend/test/transcript.test.js`

**Interfaces:**
- Consumes: nothing (leaf module)
- Produces:
  - `parseEvent(line: string) => Event | null` where
    `Event = { uuid: string, sessionId: string, ts: number, type: 'user'|'assistant', cwd: string, gitBranch: string, entrypoint: string|null, isSidechain: boolean }`
  - `fileEntrypoint(events: Event[]) => string | null`
  - `isBillable(entrypoint: string|null) => boolean`
  - `BILLABLE_ENTRYPOINTS: Set<string>`

- [ ] **Step 1: Write the failing test**

Create `backend/test/transcript.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix backend`
Expected: FAIL — `Cannot find module '../lib/transcript'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/lib/transcript.js`:

```js
// Normalises one raw transcript JSONL line into a countable activity event.
// Pure: no fs, no clock, no process lookups — so every branch is testable
// from one machine, matching the injection style in lib/categorize.js.

// Types that carry a usable activity timestamp. Everything else in a
// transcript (ai-title, mode, file-history-*, queue-operation) is metadata.
const ACTIVITY_TYPES = new Set(['user', 'assistant']);

// Only interactive CLI work is billable. sdk-cli and sdk-py are programmatic
// runs — agent swarms and pipelines that execute unattended and many at once.
// Counting them would bill hours nobody was present for.
const BILLABLE_ENTRYPOINTS = new Set(['cli']);

function parseEvent(line) {
  if (typeof line !== 'string' || !line.trim()) return null;

  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (!ACTIVITY_TYPES.has(raw.type)) return null;
  if (typeof raw.uuid !== 'string' || !raw.uuid) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;

  // ISO-8601 instant -> epoch ms. This is timezone-safe: the instant is
  // absolute. (CLAUDE.md's toISOString() ban is about emitting date LABELS,
  // which this module never does.)
  const ts = Date.parse(raw.timestamp);
  if (!Number.isFinite(ts)) return null;

  return {
    uuid: raw.uuid,
    sessionId: raw.sessionId,
    ts,
    type: raw.type,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    gitBranch: typeof raw.gitBranch === 'string' ? raw.gitBranch : '',
    entrypoint: typeof raw.entrypoint === 'string' && raw.entrypoint ? raw.entrypoint : null,
    isSidechain: raw.isSidechain === true,
  };
}

// entrypoint never varies inside a transcript (verified across all 1,560 local
// files), so the first stated value identifies the whole file. A file that
// never states one stays null and is excluded downstream — under-report
// rather than guess.
function fileEntrypoint(events) {
  for (const event of events) {
    if (event && event.entrypoint) return event.entrypoint;
  }
  return null;
}

function isBillable(entrypoint) {
  return BILLABLE_ENTRYPOINTS.has(entrypoint);
}

module.exports = {
  ACTIVITY_TYPES, BILLABLE_ENTRYPOINTS,
  parseEvent, fileEntrypoint, isBillable,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix backend`
Expected: PASS — all previous tests plus the new ones

- [ ] **Step 5: Commit**

```bash
git add backend/lib/transcript.js backend/test/transcript.test.js
git commit -m "feat(backend): normalise transcript rows into countable events"
```

---

### Task 2: Durable append-only ledger (`lib/ledger.js`)

**Files:**
- Create: `backend/lib/ledger.js`
- Test: `backend/test/ledger.test.js`

**Interfaces:**
- Consumes: nothing (leaf module)
- Produces: `createLedger(dir = DEFAULT_DIR)` returning
  - `load() => number` — rebuilds the seen-uuid index, returns its size
  - `append(events: Event[]) => number` — writes only unseen uuids, returns count written
  - `readState() => { version: 1, files: Record<string, {offset: number, entrypoint: string|null}> }`
  - `writeState(state) => void` — atomic
  - `size() => number`, `has(uuid) => boolean`
  - `eventsPath: string`, `statePath: string`

- [ ] **Step 1: Write the failing test**

Create `backend/test/ledger.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix backend`
Expected: FAIL — `Cannot find module '../lib/ledger'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/lib/ledger.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

// Our own store, not a Claude file. Claude Code deletes transcripts after
// ~30 days; this is the copy that outlives them.
const DEFAULT_DIR = path.join(os.homedir(), '.claude', 'session-jibble');
const EVENTS_FILE = 'events.jsonl';
const STATE_FILE = 'ingest-state.json';
const STATE_VERSION = 1;

function createLedger(dir = DEFAULT_DIR) {
  const eventsPath = path.join(dir, EVENTS_FILE);
  const statePath = path.join(dir, STATE_FILE);
  const seen = new Set();
  let loaded = false;

  const ensureDir = () => fs.mkdirSync(dir, { recursive: true });

  function load() {
    seen.clear();
    let text = '';
    try {
      text = fs.readFileSync(eventsPath, 'utf8');
    } catch {
      text = '';
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && event.uuid) seen.add(event.uuid);
      } catch {
        // A torn final line from an interrupted append. Skipping it means the
        // event is re-ingested next run, which is safe: append dedupes.
      }
    }
    loaded = true;
    return seen.size;
  }

  // Idempotent by uuid, so a crash mid-run, a re-scan, or a full rebuild can
  // never write the same event twice and inflate billed hours.
  function append(events) {
    if (!loaded) load();
    const fresh = [];
    for (const event of events) {
      if (!event || !event.uuid || seen.has(event.uuid)) continue;
      seen.add(event.uuid);
      fresh.push(event);
    }
    if (fresh.length) {
      ensureDir();
      fs.appendFileSync(eventsPath, `${fresh.map(e => JSON.stringify(e)).join('\n')}\n`);
    }
    return fresh.length;
  }

  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (raw && raw.version === STATE_VERSION && raw.files && typeof raw.files === 'object') {
        return raw;
      }
    } catch {
      // Missing or corrupt: fall through. Re-scanning from offset 0 is safe
      // because append dedupes — we lose time, never correctness.
    }
    return { version: STATE_VERSION, files: {} };
  }

  // Temp-then-rename: rename is atomic on POSIX, so an interrupted run leaves
  // the previous state intact rather than a truncated file. Matches
  // lib/config.js:saveConfig.
  function writeState(state) {
    ensureDir();
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath);
  }

  return {
    dir, eventsPath, statePath,
    load, append, readState, writeState,
    has: uuid => seen.has(uuid),
    size: () => seen.size,
  };
}

module.exports = { createLedger, DEFAULT_DIR, EVENTS_FILE, STATE_FILE, STATE_VERSION };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix backend`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/lib/ledger.js backend/test/ledger.test.js
git commit -m "feat(backend): add idempotent append-only event ledger"
```

---

### Task 3: Incremental transcript walker (`lib/ingest.js`)

**Files:**
- Create: `backend/lib/ingest.js`
- Test: `backend/test/ingest.test.js`

**Interfaces:**
- Consumes: `parseEvent`, `fileEntrypoint`, `isBillable` from `./transcript`; a ledger from `./ledger`
- Produces:
  - `readTail(filePath, fromByte) => { lines: string[], nextOffset: number }`
  - `listTranscripts(projectsDir) => string[]`
  - `ingest(ledger, projectsDir = DEFAULT_PROJECTS_DIR) => Summary` where
    `Summary = { filesScanned, filesChanged, eventsAppended, skippedNonBillable, byEntrypoint: Record<string, number> }`
  - `DEFAULT_PROJECTS_DIR: string`

- [ ] **Step 1: Write the failing test**

Create `backend/test/ingest.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix backend`
Expected: FAIL — `Cannot find module '../lib/ingest'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/lib/ingest.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEvent, fileEntrypoint, isBillable } = require('./transcript');

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Transcripts are append-only, so a run reads only the bytes added since the
// last one. Claude Code may be mid-write, so the trailing partial line is left
// unconsumed and picked up next run — nextOffset always lands just past a \n,
// which also keeps the offset on a UTF-8 character boundary.
function readTail(filePath, fromByte) {
  const { size } = fs.statSync(filePath);
  const start = size < fromByte ? 0 : fromByte;   // shrank -> replaced, re-read
  if (size <= start) return { lines: [], nextOffset: start };

  const fd = fs.openSync(filePath, 'r');
  let text;
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }

  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) return { lines: [], nextOffset: start };

  const complete = text.slice(0, lastNewline);
  return {
    lines: complete.split('\n').filter(line => line.trim()),
    nextOffset: start + Buffer.byteLength(complete, 'utf8') + 1,
  };
}

// ~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl — exactly one level deep.
function listTranscripts(projectsDir = DEFAULT_PROJECTS_DIR) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.jsonl')) out.push(path.join(dir, file));
    }
  }
  return out.sort();
}

function ingest(ledger, projectsDir = DEFAULT_PROJECTS_DIR) {
  const state = ledger.readState();
  const files = state.files;
  const summary = {
    filesScanned: 0, filesChanged: 0, eventsAppended: 0,
    skippedNonBillable: 0, byEntrypoint: {},
  };

  const count = (key) => { summary.byEntrypoint[key] = (summary.byEntrypoint[key] || 0) + 1; };

  for (const filePath of listTranscripts(projectsDir)) {
    summary.filesScanned += 1;
    const prev = files[filePath] || { offset: 0, entrypoint: null };

    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      continue;                       // deleted mid-scan
    }

    // Once a file is known non-billable, skip parsing it forever and just keep
    // its offset current. 1,457 of 1,560 local transcripts are SDK runs, so
    // this is where nearly all the scan cost would otherwise go.
    if (prev.entrypoint && !isBillable(prev.entrypoint)) {
      count(prev.entrypoint);
      summary.skippedNonBillable += 1;
      if (size !== prev.offset) {
        files[filePath] = { offset: size, entrypoint: prev.entrypoint };
        summary.filesChanged += 1;
      }
      continue;
    }

    let tail;
    try {
      tail = readTail(filePath, prev.offset);
    } catch {
      continue;
    }
    if (!tail.lines.length) {
      if (prev.entrypoint) count(prev.entrypoint);
      continue;
    }

    const events = [];
    for (const line of tail.lines) {
      const event = parseEvent(line);
      if (event) events.push(event);
    }

    // A file's entrypoint is fixed, so a cached value wins — later appended
    // rows may omit the field entirely.
    const entrypoint = prev.entrypoint || fileEntrypoint(events);
    count(entrypoint || 'unknown');

    if (isBillable(entrypoint)) {
      // Sidechain rows are subagent chatter inside the session; the parent
      // session's own rows already cover that wall-clock time.
      const billable = events.filter(event => !event.isSidechain);
      summary.eventsAppended += ledger.append(billable.map(event => ({
        uuid: event.uuid,
        sessionId: event.sessionId,
        ts: event.ts,
        type: event.type,
        cwd: event.cwd,
        gitBranch: event.gitBranch,
      })));
    } else {
      summary.skippedNonBillable += 1;
    }

    files[filePath] = { offset: tail.nextOffset, entrypoint };
    summary.filesChanged += 1;
  }

  ledger.writeState(state);
  return summary;
}

module.exports = { readTail, listTranscripts, ingest, DEFAULT_PROJECTS_DIR };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix backend`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/lib/ingest.js backend/test/ingest.test.js
git commit -m "feat(backend): incrementally ingest cli transcripts into the ledger"
```

---

### Task 4: Runnable entry point and docs

**Files:**
- Create: `backend/bin/ingest.js`
- Modify: `backend/package.json` (add `ingest` script)
- Modify: `package.json` (add root `ingest` script)
- Modify: `CLAUDE.md` (document the ledger and the retention deadline)

**Interfaces:**
- Consumes: `createLedger` from `lib/ledger`, `ingest` from `lib/ingest`.
  `ingest()` returns `Summary = {filesScanned, filesChanged, eventsAppended, skippedNonBillable, errors, byEntrypoint}`.
  The `errors` field was added during Task 3's fix round — a bare catch that reported a
  permissions failure as a clean run. It MUST be surfaced here, not swallowed.
- Produces: `npm run ingest` — exits 0 on a clean run, 1 if any file could not be read

- [ ] **Step 1: Write the entry point**

Create `backend/bin/ingest.js`:

```js
#!/usr/bin/env node
// Snapshots interactive Claude Code transcripts into our own durable ledger.
// Claude Code deletes transcripts after ~30 days; anything not captured before
// then is unrecoverable, so this is meant to run on a schedule.

const { createLedger } = require('../lib/ledger');
const { ingest } = require('../lib/ingest');

function main() {
  const ledger = createLedger();
  const before = ledger.load();
  const summary = ingest(ledger);

  const byEntrypoint = Object.entries(summary.byEntrypoint)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}=${n}`)
    .join(' ');

  console.log(`scanned   ${summary.filesScanned} transcripts (${summary.filesChanged} with new data)`);
  console.log(`skipped   ${summary.skippedNonBillable} non-interactive`);
  console.log(`appended  ${summary.eventsAppended} events (ledger ${before} -> ${ledger.size()})`);
  console.log(`files     ${byEntrypoint}`);
  console.log(`ledger    ${ledger.eventsPath}`);

  // A capture job that fails quietly is the failure this whole plan exists to
  // prevent: an unreadable projects dir would otherwise print a clean run while
  // silently capturing nothing. Surface it loudly and exit non-zero.
  if (summary.errors > 0) {
    console.error(`WARNING   ${summary.errors} file(s) could not be read — capture is INCOMPLETE`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(`ingest failed: ${err.message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Wire up the npm scripts**

In `backend/package.json`, add to `scripts`:

```json
"ingest": "node bin/ingest.js"
```

In the root `package.json`, add to `scripts`:

```json
"ingest": "npm run ingest --prefix backend"
```

- [ ] **Step 3: Run it against real data and verify**

Run: `npm run ingest`

Expected: a summary naming roughly 1,560 transcripts scanned, ~1,460 skipped as
non-interactive, and events appended into `~/.claude/session-jibble/events.jsonl`.
`errors` should be 0; if the WARNING line appears, investigate before continuing —
an incomplete capture is the one outcome this job must never report as success.

Then verify idempotency — run it a second time:

Run: `npm run ingest`
Expected: `appended  0 events`

- [ ] **Step 4: Confirm the full suite still passes**

Run: `npm test --prefix backend`
Expected: PASS, with no pre-existing test broken.

- [ ] **Step 5: Document it in CLAUDE.md**

Add to the "Data sources" table:

```markdown
| `session-jibble/events.jsonl` | Our durable copy of interactive transcript events (not a Claude file) |
| `session-jibble/ingest-state.json` | Per-transcript byte offsets so ingest reads only new data |
```

Add a new subsection under "Key design decisions":

```markdown
### Transcript ingestion (time-critical)
`~/.claude/projects/**/*.jsonl` holds message-level timestamps far richer than
`history.jsonl`, but Claude Code deletes them after ~30 days. `npm run ingest`
copies interactive (`entrypoint === 'cli'`) events into
`~/.claude/session-jibble/events.jsonl` before they expire. It is incremental
(byte offsets in `ingest-state.json`) and idempotent (dedupe by event `uuid`),
so running it often is free and running it twice is harmless.

It stores **raw events, never computed durations** — duration rules will change,
and intervals can always be recomputed from events, while events cannot be
recovered once deleted.

`sdk-cli` and `sdk-py` transcripts are excluded: those are unattended agent runs,
not human work.
```

- [ ] **Step 6: Commit**

```bash
git add backend/bin/ingest.js backend/package.json package.json CLAUDE.md
git commit -m "feat: add npm run ingest to capture transcripts before they expire"
```

---

### Task 5: Global SessionStart hook

**Files:**
- Modify: `~/.claude/settings.json` (GLOBAL user settings — deliberately not project settings)

**Interfaces:**
- Consumes: `backend/bin/ingest.js` from Task 4
- Produces: nothing consumed by later tasks

**Why global, not project:** a hook in `session-jibble/.claude/settings.json` fires only
when a session starts *in this repo*. The work being captured happens across 92 other
repos, so a project-scoped hook would capture almost nothing. It must live in
`~/.claude/settings.json`.

**Environment note (already verified):** `node` resolves on PATH in login, non-login,
and stripped-environment shells on this machine (`/usr/local/bin/node` v24.16.0 exists
independently of nvm), so the command uses a bare `node` rather than an absolute path
that an nvm upgrade would silently break.

- [ ] **Step 1: Verify the command works before wiring it to anything**

Run exactly the command the hook will run:

```bash
mkdir -p "$HOME/.claude/session-jibble" && node /Users/karthikkumarrajarat/ai-research/session-jibble/backend/bin/ingest.js >> "$HOME/.claude/session-jibble/ingest.log" 2>&1; echo "exit=$?"
```

Expected: `exit=0`

Then confirm it actually wrote a summary rather than failing silently:

```bash
tail -5 "$HOME/.claude/session-jibble/ingest.log"
```

Expected: the `scanned / skipped / appended / files / ledger` lines from Task 4.
If the log is empty or shows an error, STOP and fix before editing settings.json.

- [ ] **Step 2: Read the existing settings file**

```bash
cat ~/.claude/settings.json
```

It currently has no `hooks` key. Confirm that before writing — if a `hooks` key has
appeared since this plan was written, MERGE into it rather than replacing it.

- [ ] **Step 3: Add the hook, preserving every existing setting**

Add a top-level `"hooks"` key to `~/.claude/settings.json`. Do not modify or reorder
`permissions`, `model`, `statusLine`, `enabledPlugins`, `extraKnownMarketplaces`,
`spinnerVerbs`, `autoMode`, or any other existing key.

```json
"hooks": {
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "mkdir -p \"$HOME/.claude/session-jibble\" && node /Users/karthikkumarrajarat/ai-research/session-jibble/backend/bin/ingest.js >> \"$HOME/.claude/session-jibble/ingest.log\" 2>&1 || true",
          "async": true,
          "timeout": 120
        }
      ]
    }
  ]
}
```

`async: true` keeps session startup instant — ingest never blocks the prompt.
Output is redirected to a log rather than discarded, so a failure is diagnosable
instead of invisible. `|| true` ensures a broken ingest can never break session start.

- [ ] **Step 4: Validate the JSON and the hook schema in one shot**

```bash
jq -e '.hooks.SessionStart[].hooks[] | select(.type == "command") | .command' ~/.claude/settings.json
```

Expected: exit 0 and prints the command string.
Exit 5 means malformed JSON or wrong nesting — a broken settings.json silently
disables ALL settings from that file, so fix it immediately.

Then confirm nothing else was lost:

```bash
jq -e '.permissions.defaultMode, .model, (.enabledPlugins | length)' ~/.claude/settings.json
```

Expected: `"auto"`, `"opus"`, `19`

- [ ] **Step 5: Hand off for verification**

`SessionStart` fires outside the current turn, so it cannot be proven from inside this
session. Tell the user:

- The hook is written and schema-valid.
- Claude Code only watches directories that had a settings file at session start, so
  the hook may not load until they open `/hooks` once or restart Claude Code.
- After their next new session, `tail -5 ~/.claude/session-jibble/ingest.log` should
  show a fresh summary with a newer timestamp than the Step 1 run.
- `/hooks` is where they review, edit, or disable it later.

- [ ] **Step 6: Commit**

`~/.claude/settings.json` is outside this repo and is not committed. Instead, record
the dependency so the hook is reproducible:

Add to `CLAUDE.md` under the transcript-ingestion subsection:

```markdown
Ingest is wired to a global `SessionStart` hook in `~/.claude/settings.json` (global,
not project — the work being captured spans every repo, not just this one). It runs
`async` and logs to `~/.claude/session-jibble/ingest.log`. Review it with `/hooks`.
```

```bash
git add CLAUDE.md
git commit -m "docs: record the global SessionStart ingest hook"
```

---

## Follow-on plans (not in scope here)

1. **Duration engine** — presence gate, 10-minute gap cap, density-based overlap split, computed over the ledger.
2. **Client mapping** — git-remote resolution (`airline.gitlab.airasia.com` billable, `github.com` not), replacing the `work`/`nonWork` binary and removing the `contains` substring rules.
3. **TRIP attribution + Jibble write** — assignment UI over proposed blocks, then `add_hour_entries`.
