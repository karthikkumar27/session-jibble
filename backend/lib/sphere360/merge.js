// Pure. The safety core of the sync.
//
// `/api/timesheets/upsert` carries the whole week's entries, and is assumed to
// REPLACE that week. So anything filed but absent from the posted array is
// destroyed — including the meetings, scrums and leave this app cannot see and
// must never touch. Every rule here exists to make that impossible.

// Ownership key: the same triple draft.js groups by. A drafted row owns a filed
// row when both describe the same work on the same day. A missing projectId and
// an empty one are the same absence, so non-project rows key stably.
//
// JSON.stringify, not join('|'): a separator an id may itself contain can alias
// two distinct triples, and a false match here DELETES a filed row. JSON quotes
// and escapes each field, so the encoding is injective.
function entryKey(entry) {
  return JSON.stringify([entry.workDate, entry.projectId ?? '', entry.activityId]);
}

// The probe found filed entries carry a stable `id` and `timesheetId`. A drafted
// row that supersedes a filed one must carry them forward, or the write is a
// delete-and-recreate: the old id disappears from the posted array, the server
// destroys that row and inserts a new one, and anything referring to it — an
// approval trail, an export already sent — breaks to change one number.
//
// Only the identity is borrowed. hours, comments, projectId and activityId stay
// the drafted row's, and isBillable/activity are the server's to derive. A row
// matching nothing inherits nothing: an id taken from a row that is NOT being
// superseded would overwrite that row and destroy this work instead of adding
// it. The row is copied rather than edited in place, so `replaced` keeps
// rendering what was actually filed.
function inheritIdentity(row, owner) {
  if (!owner) return row;
  const carried = {};
  if (owner.id !== undefined) carried.id = owner.id;
  if (owner.timesheetId !== undefined) carried.timesheetId = owner.timesheetId;
  // Nothing to carry, nothing to copy: a row filed before ids existed must not
  // gain an explicit `id: undefined` that a JSON round trip could render null.
  return Object.keys(carried).length ? { ...row, ...carried } : row;
}

function mergeWeek({ filed = [], drafted = [], __forceDrop = false }) {
  const draftedKeys = new Set(drafted.map(entryKey));

  // Key -> the filed row a drafted row would supersede. First wins: if the
  // server ever files two rows under one key, both are `replaced` and the
  // single surviving drafted row can only carry one identity.
  const ownerByKey = new Map();
  for (const row of filed) {
    const k = entryKey(row);
    if (!ownerByKey.has(k)) ownerByKey.set(k, row);
  }

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

  // Kept rows go into the union by identity, never rebuilt from a field list:
  // they are Sphere360's rows, carrying isBillable, activity and anything a
  // future API version adds, and this endpoint replaces the week with exactly
  // what it is posted. Reconstructing them would silently strip whatever we
  // did not think to copy.
  const owned = drafted.map(row => inheritIdentity(row, ownerByKey.get(entryKey(row))));

  // __forceDrop exists only so the invariant below is provably live in tests.
  // Nothing in production sets it.
  const entries = __forceDrop ? [...owned] : [...kept, ...owned];

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
