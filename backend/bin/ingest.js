#!/usr/bin/env node
// Snapshots interactive Claude Code transcripts into our own durable ledger.
// Claude Code deletes transcripts after ~30 days; anything not captured before
// then is unrecoverable, so this is meant to run on a schedule.

const { createLedger, DEFAULT_DIR } = require('../lib/ledger');
const { ingest } = require('../lib/ingest');
const { acquireLock } = require('../lib/lock');

function run() {
  const ledger = createLedger();
  const before = ledger.load();
  const summary = ingest(ledger);

  const byEntrypoint = Object.entries(summary.byEntrypoint)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}=${n}`)
    .join(' ');

  console.log(`scanned      ${summary.filesScanned} transcript files (${summary.filesChanged} with new data)`);
  // Split deliberately: "skipped N non-interactive" used to sum SDK files and
  // unclassified ones together, which reads as "all N were programmatic". The
  // unclassified line is the one that means capture may be incomplete.
  console.log(`excluded     ${summary.filesExcludedSdk} files stating an sdk entrypoint (unattended)`);
  console.log(`unclassified ${summary.filesUnclassified} files (no entrypoint, no sign of a human) — NOT captured`);
  console.log(`appended     ${summary.eventsAppended} events (ledger ${before} -> ${ledger.size()} events)`);
  console.log(`files        ${byEntrypoint}`);
  console.log(`ledger       ${ledger.eventsPath}`);

  // A capture job that fails quietly is the failure this whole plan exists to
  // prevent: an unreadable projects dir would otherwise print a clean run while
  // silently capturing nothing. Surface it loudly and exit non-zero.
  if (summary.errors > 0) {
    console.error(`WARNING      ${summary.errors} unreadable file(s)/corrupt line(s) — capture is INCOMPLETE`);
    process.exitCode = 1;
  }
}

function main() {
  // The SessionStart hook is global, so runs overlap routinely. Without a lock
  // two of them load the same ledger snapshot and both append the same uuids.
  const lock = acquireLock(DEFAULT_DIR);
  if (!lock) {
    // Not an error: the run holding the lock is capturing the same transcripts,
    // and the next session start captures anything it misses.
    console.log('another ingest run is in progress — skipping this one');
    return;
  }
  try {
    run();
  } finally {
    lock.release();
  }
}

try {
  main();
} catch (err) {
  console.error(`ingest failed: ${err.message}`);
  process.exit(1);
}
