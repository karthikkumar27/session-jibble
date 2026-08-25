const fs = require('fs');
const path = require('path');

// Cross-process mutual exclusion for the ingest run.
//
// The SessionStart hook is global: it fires on every session start across every
// repository, so two runs overlapping is normal, not exotic. The ledger's dedupe
// set lives in one process, so two runs would each load the same snapshot, read
// the same tails and each append the same uuids — duplicates in an append-only
// store that nothing repairs. Interleaved multi-megabyte appends can also tear
// a line. One writer at a time is the only thing that prevents both.

const LOCK_FILE = 'ingest.lock';

// A cold run over ~1,600 transcripts takes seconds. Five minutes is two orders
// of magnitude of headroom, so a lock older than this is from a process that
// died without cleaning up — not one still working.
const STALE_MS = 5 * 60 * 1000;

// signal 0 does no work but still performs the permission and existence checks.
// EPERM means the pid exists and belongs to someone else — still alive.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readHolder(lockPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;   // missing, truncated or half-written
  }
}

function isStale(lockPath, staleMs, isAlive, now) {
  const holder = readHolder(lockPath);
  if (!holder) return true;                       // unreadable: nobody can own it
  if (Number.isInteger(holder.pid) && !isAlive(holder.pid)) return true;
  if (!Number.isFinite(holder.at)) return true;   // no timestamp to age out on
  return now() - holder.at > staleMs;
}

// Returns a handle, or null when another run already holds the lock. Callers
// treat null as "nothing to do" rather than an error: the next session start
// captures whatever this run would have.
//
// Behaviour is injected (staleMs / isAlive / now) rather than read from the
// process, so both the held and stale branches are testable from one machine —
// same style as lib/categorize.js.
function acquireLock(dir, staleMs = STALE_MS, isAlive = processAlive, now = Date.now) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK_FILE);
  const mine = { pid: process.pid, at: now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // 'wx' is O_CREAT|O_EXCL: the create either wins outright or fails. The
      // check and the claim are one syscall, so there is no race between them.
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(mine));
      } finally {
        fs.closeSync(fd);
      }
      return {
        path: lockPath,
        // Only remove a lock we still own. If ours was declared stale and
        // another run took it, deleting it here would hand a third run a lock
        // that is already held.
        release() {
          const holder = readHolder(lockPath);
          if (holder && holder.pid === mine.pid && holder.at === mine.at) {
            try {
              fs.unlinkSync(lockPath);
            } catch {
              // Already gone — someone reclaimed it as stale. Nothing to undo.
            }
          }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (attempt > 0) return null;                          // lost the retry race
      if (!isStale(lockPath, staleMs, isAlive, now)) return null;
      try {
        fs.unlinkSync(lockPath);                             // reclaim an abandoned lock
      } catch {
        return null;                                         // another run beat us to it
      }
    }
  }
  return null;
}

module.exports = { acquireLock, LOCK_FILE, STALE_MS };
