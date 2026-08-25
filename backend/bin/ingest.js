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
