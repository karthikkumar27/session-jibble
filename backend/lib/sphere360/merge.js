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

  const kept = [];
  const replaced = [];
  for (const row of filed) {
    (draftedKeys.has(entryKey(row)) ? replaced : kept).push(row);
  }

  // __forceDrop exists only so the invariant below is provably live in tests.
  // Nothing in production sets it.
  const entries = __forceDrop ? [...drafted] : [...kept, ...drafted];

  // Rule 4: refuse to hand the network a union that lost a filed row. Cheap,
  // and it turns a whole class of refactor bug into a failed request instead of
  // a deleted timesheet.
  if (entries.length < filed.length - replaced.length) {
    throw new Error(
      `merge would drop ${filed.length - replaced.length - entries.length} filed row(s); refusing to post`
    );
  }

  return { entries, replaced, kept };
}

module.exports = { entryKey, mergeWeek };
