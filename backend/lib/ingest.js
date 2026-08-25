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
  let bytesRead;
  try {
    const buf = Buffer.alloc(size - start);
    bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
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

function ingest(ledger, projectsDir = DEFAULT_PROJECTS_DIR) {
  const state = ledger.readState();
  const files = state.files;
  const summary = {
    filesScanned: 0, filesChanged: 0, eventsAppended: 0,
    skippedNonBillable: 0, errors: 0, byEntrypoint: {},
  };

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
      continue;
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
      onError();
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
