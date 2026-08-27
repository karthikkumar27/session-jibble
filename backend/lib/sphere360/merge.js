// Pure. The safety core of the sync.
//
// `/api/timesheets/upsert` carries the whole week's entries, and is assumed to
// REPLACE that week. So anything filed but absent from the posted array is
// destroyed — including the meetings, scrums and leave this app cannot see and
// must never touch. Every rule here exists to make that impossible.

// Ownership key: the same triple draft.js groups by. A drafted row owns a filed
// row when both describe the same work on the same day. A missing projectId and
// an empty one are the same absence, so non-project rows key stably.
function entryKey(entry) {
  return [entry.workDate, entry.projectId ?? '', entry.activityId].join('|');
}

function mergeWeek({ filed = [], drafted = [], __forceDrop = false }) {
  const draftedKeys = new Set(drafted.map(entryKey));

  // If the server ever files two rows under the same key, both land in
  // `replaced` when a drafted row matches that key — not one kept and one
  // replaced. That's deliberate: the UI renders every `replaced` row struck
  // through, so the operator sees exactly what is being superseded, and no
  // row is silently kept alongside a drafted one under the same key (which
  // would triplicate the cell instead).
  const kept = [];
  const replaced = [];
  for (const row of filed) {
    (draftedKeys.has(entryKey(row)) ? replaced : kept).push(row);
  }

  // __forceDrop exists only so the invariant below is provably live in tests.
  // Nothing in production sets it.
  const entries = __forceDrop ? [...drafted] : [...kept, ...drafted];

  // Rule 4: every filed row we did not deliberately replace must survive into
  // the union — checked by identity, not by counting. A count comparison cannot
  // express this: kept.length + replaced.length always equals filed.length, so
  // the arithmetic reduces to `drafted.length < 0` and never fires. It would
  // also pass a refactor that returned only `drafted` whenever there were at
  // least as many drafted rows as kept ones — precisely the bug it must catch.
  const dropped = kept.filter(row => !entries.includes(row));
  if (dropped.length) {
    throw new Error(`merge would drop ${dropped.length} filed row(s); refusing to post`);
  }

  return { entries, replaced, kept };
}

module.exports = { entryKey, mergeWeek };
