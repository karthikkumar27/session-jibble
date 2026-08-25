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
