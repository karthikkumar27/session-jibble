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
    } catch (err) {
      // ONLY "no ledger yet" may be treated as an empty ledger. Any other
      // failure (EACCES, EISDIR, ERR_STRING_TOO_LONG once the file outgrows
      // Node's max string length) means the events ARE there but we cannot see
      // them — and a silent seen={} would make the next append rewrite every
      // one of them as fresh, doubling billed hours.
      if (err.code !== 'ENOENT') throw err;
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

  // Idempotent by uuid WITHIN A PROCESS: `seen` is per-process, so a crash
  // mid-run, a re-scan or a full rebuild never write the same event twice.
  // Two ingest runs overlapping in time would each load the same snapshot and
  // each append the same uuids, so concurrency is excluded one level up by the
  // lockfile in lib/lock.js — this function cannot do it alone.
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

  // has()/size() lazy-load exactly like append(): a consumer that only reads
  // (the duration engine) would otherwise see an empty ledger and report zero
  // hours from a full store.
  const ensureLoaded = () => { if (!loaded) load(); };

  return {
    dir, eventsPath, statePath,
    load, append, readState, writeState,
    has: (uuid) => { ensureLoaded(); return seen.has(uuid); },
    size: () => { ensureLoaded(); return seen.size; },
  };
}

module.exports = { createLedger, DEFAULT_DIR, EVENTS_FILE, STATE_FILE, STATE_VERSION };
