// Normalises one raw transcript JSONL line into a countable activity event.
// Pure: no fs, no clock, no process lookups — so every branch is testable
// from one machine, matching the injection style in lib/categorize.js.

// Types that carry a usable activity timestamp. Everything else in a
// transcript (ai-title, mode, file-history-*, queue-operation) is metadata.
const ACTIVITY_TYPES = new Set(['user', 'assistant']);

// Row types that only ever exist in an attended session: a queued prompt and a
// permission-mode toggle both require a person at the keyboard. Used only as a
// fallback signal for files that state no entrypoint at all (see
// hasInteractiveMarkers) — SDK transcripts carry these rows too.
const INTERACTIVE_TYPES = new Set(['last-prompt', 'permission-mode']);

// Marks a file that states no entrypoint anywhere but shows human presence.
// Kept distinct from a stated 'cli' so the ingest summary reports inferred
// classifications separately and an operator can see what was guessed.
const INFERRED_INTERACTIVE = 'interactive';

// Only interactive work is billable. sdk-cli and sdk-py are programmatic
// runs — agent swarms and pipelines that execute unattended and many at once.
// Counting them would bill hours nobody was present for.
const BILLABLE_ENTRYPOINTS = new Set(['cli', INFERRED_INTERACTIVE]);

// Returned instead of null when a line is corrupt rather than merely
// uncountable. The two cases are indistinguishable to the caller otherwise,
// and swallowing corruption inside a billable transcript is how real work
// disappears without a trace: the offset advances past the line forever.
const MALFORMED = Symbol('malformed transcript line');

// Blank lines and rows we cannot decode are not transcript rows at all; every
// scan that walks raw lines shares this so they agree on what a row is.
function parseRow(line) {
  if (typeof line !== 'string' || !line.trim()) return null;
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  return raw && typeof raw === 'object' ? raw : null;
}

function parseEvent(line) {
  // Blank padding is not corruption — an appended chunk can start or end with
  // one and nothing is lost by ignoring it.
  if (typeof line !== 'string' || !line.trim()) return null;

  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return MALFORMED;
  }
  if (!raw || typeof raw !== 'object') return MALFORMED;

  // A metadata row (ai-title, mode, file-history-*) is a legitimate,
  // uncountable line — not an error.
  if (!ACTIVITY_TYPES.has(raw.type)) return null;

  // Past this point the row claims to BE activity. One that cannot be
  // identified or placed in time is corrupt, and must be counted as such.
  if (typeof raw.uuid !== 'string' || !raw.uuid) return MALFORMED;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return MALFORMED;

  // ISO-8601 instant -> epoch ms. This is timezone-safe: the instant is
  // absolute. (CLAUDE.md's toISOString() ban is about emitting date LABELS,
  // which this module never does.)
  const ts = Date.parse(raw.timestamp);
  if (!Number.isFinite(ts)) return MALFORMED;

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

// entrypoint never varies inside a transcript (verified across all local
// files), so the first stated value identifies the whole file.
//
// This scans RAW lines, not parsed events, and that is the whole point: the
// field appears on system, attachment and mode rows too, and a transcript can
// carry it on nothing but those. Looking only at user/assistant rows left such
// files permanently unclassified — real interactive work, dropped in silence.
function fileEntrypoint(lines) {
  for (const line of lines) {
    const raw = parseRow(line);
    if (raw && typeof raw.entrypoint === 'string' && raw.entrypoint) return raw.entrypoint;
  }
  return null;
}

// Fallback for a file that states no entrypoint anywhere: did a human drive it?
// `userType: "external"` is Claude Code's own label for a row that came from
// the person rather than from an agent, and a non-sidechain one is the parent
// session's own turn.
//
// These markers appear in SDK transcripts too, so this is ONLY meaningful when
// fileEntrypoint() found nothing — a stated sdk-cli / sdk-py must still win and
// keep the file excluded.
function hasInteractiveMarkers(lines) {
  for (const line of lines) {
    const raw = parseRow(line);
    if (!raw) continue;
    if (INTERACTIVE_TYPES.has(raw.type)) return true;
    if (raw.userType === 'external' && raw.isSidechain !== true) return true;
  }
  return false;
}

function isBillable(entrypoint) {
  return BILLABLE_ENTRYPOINTS.has(entrypoint);
}

module.exports = {
  ACTIVITY_TYPES, BILLABLE_ENTRYPOINTS, INTERACTIVE_TYPES, INFERRED_INTERACTIVE, MALFORMED,
  parseRow, parseEvent, fileEntrypoint, hasInteractiveMarkers, isBillable,
};
