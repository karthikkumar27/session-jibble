const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseEvent, fileEntrypoint, hasInteractiveMarkers, isBillable,
  INFERRED_INTERACTIVE, MALFORMED,
} = require('./transcript');

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
  try {
    const buf = Buffer.alloc(size - start);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    // A short read must not fall through: lastIndexOf(0x0A, -1) searches from
    // the end of the buffer, which Buffer.alloc has zero-filled, so it would
    // return an index into bytes we never read.
    if (bytesRead <= 0) return { lines: [], nextOffset: start };

    const i = buf.lastIndexOf(0x0A, bytesRead - 1);
    if (i === -1) return { lines: [], nextOffset: start };

    const complete = buf.subarray(0, i).toString('utf8');
    return {
      lines: complete.split('\n').filter(line => line.trim()),
      nextOffset: start + i + 1,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl — exactly one level deep.
function listTranscripts(projectsDir = DEFAULT_PROJECTS_DIR, onError) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (e) {
    if (onError) onError();
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      if (onError) onError();
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.jsonl')) out.push(path.join(dir, file));
    }
  }
  return out.sort();
}

// A stated entrypoint always wins over an inferred one — including over an
// inference this ingest cached earlier. A later tail may be the first chunk of
// the file to state sdk-cli / sdk-py, and that must exclude the file for good.
function statedCache(cached) {
  return cached === INFERRED_INTERACTIVE ? null : cached;
}

function ingest(ledger, projectsDir = DEFAULT_PROJECTS_DIR) {
  const state = ledger.readState();
  const files = state.files;
  const summary = {
    filesScanned: 0,
    filesChanged: 0,
    eventsAppended: 0,          // EVENTS, not files
    filesExcludedSdk: 0,        // FILES that state sdk-cli / sdk-py
    filesUnclassified: 0,       // FILES with no entrypoint and no human signal
    errors: 0,
    byEntrypoint: {},           // FILES per classification; sums to filesScanned
  };

  // Every scanned file lands in exactly one bucket, so byEntrypoint reconciles
  // with filesScanned. A bucket that silently swallows files is how an
  // incomplete capture reads as a complete one.
  const count = (key) => { summary.byEntrypoint[key] = (summary.byEntrypoint[key] || 0) + 1; };
  const onError = () => { summary.errors += 1; };

  for (const filePath of listTranscripts(projectsDir, onError)) {
    summary.filesScanned += 1;
    const prev = files[filePath] || { offset: 0, entrypoint: null };

    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      onError();                       // deleted mid-scan
      count('unreadable');
      continue;
    }

    // Once a file is known non-billable, skip parsing it forever and just keep
    // its offset current. The overwhelming majority of local transcripts are
    // SDK runs, so this is where nearly all the scan cost would otherwise go.
    if (prev.entrypoint && !isBillable(prev.entrypoint)) {
      count(prev.entrypoint);
      summary.filesExcludedSdk += 1;
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
      onError();
      count('unreadable');
      continue;
    }
    if (!tail.lines.length) {
      // A zero-byte or not-yet-flushed file still has to be accounted for.
      const known = prev.entrypoint;
      count(known || 'unknown');
      if (!known) summary.filesUnclassified += 1;
      continue;
    }

    // Scans RAW lines: entrypoint lives on system / attachment / mode rows as
    // well, and some transcripts state it on nothing else.
    const stated = fileEntrypoint(tail.lines) || statedCache(prev.entrypoint);

    // No entrypoint anywhere, but a human was clearly driving. Under the old
    // rule these files were dropped as "non-interactive" and re-read forever
    // until the transcript expired, taking the evidence with it.
    const inferred = stated
      ? null
      : (hasInteractiveMarkers(tail.lines) || prev.entrypoint === INFERRED_INTERACTIVE
        ? INFERRED_INTERACTIVE
        : null);

    const entrypoint = stated || inferred;
    count(entrypoint || 'unknown');

    const events = [];
    for (const line of tail.lines) {
      const event = parseEvent(line);
      // A corrupt line looks exactly like an ai-title row once it is dropped,
      // and the offset then advances past it forever. Count it so an operator
      // sees that this capture is incomplete.
      if (event === MALFORMED) { onError(); continue; }
      if (event) events.push(event);
    }

    if (isBillable(entrypoint)) {
      // Sidechain rows are stored too, tagged. Whether subagent chatter counts
      // toward a duration is a question for the duration engine; deciding it
      // here would destroy evidence that cannot be recovered once Claude Code
      // deletes the transcript.
      summary.eventsAppended += ledger.append(events.map(event => ({
        uuid: event.uuid,
        sessionId: event.sessionId,
        ts: event.ts,
        type: event.type,
        cwd: event.cwd,
        gitBranch: event.gitBranch,
        isSidechain: event.isSidechain,
      })));
    } else if (entrypoint) {
      summary.filesExcludedSdk += 1;
    } else {
      summary.filesUnclassified += 1;
    }

    // Only update offset if entrypoint is known; otherwise leave it unchanged
    // so the file re-reads until it classifies.
    if (entrypoint) {
      files[filePath] = { offset: tail.nextOffset, entrypoint };
      summary.filesChanged += 1;
    }
  }

  ledger.writeState(state);
  return summary;
}

module.exports = { readTail, listTranscripts, ingest, DEFAULT_PROJECTS_DIR };
