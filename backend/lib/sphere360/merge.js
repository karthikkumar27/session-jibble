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

  // Each drafted row picks up the identity of the filed row it supersedes, if
  // any, so the write updates that row rather than destroying and recreating it.
  const owned = drafted.map(row => inheritIdentity(row, ownerByKey.get(entryKey(row))));

  // Kept rows enter by identity, never rebuilt from a field list: they are
  // Sphere360's rows, carrying isBillable, activity and anything a future API
  // version adds, and this endpoint replaces the week with exactly what it is
  // posted. Reconstructing them would silently strip whatever we did not think
  // to copy.
  //
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

// Weeks carry status, isUnlocked, submittedAt and approvedAt, and until now
// nothing consulted them — a confirm would have replaced a week already
// submitted for approval, silently reopening or corrupting a signed-off record.
//
// A week with no timesheet yet is writable: [] is a proven empty week and there
// is nothing to protect. Everything else must be DRAFT, or unlocked by the
// operator's own act in Sphere360.
//
// The test is exact on both fields, and everything unrecognised fails closed.
// Refusing is recoverable — unlock the week and retry — while writing a week we
// could not classify is not, because the endpoint replaces it. `=== true` and
// not a truthy check: JSON from another system renders 'false' as a truthy
// string, and a loose read of it would write a locked week.
function weekWritable(week) {
  if (week === null || week === undefined) return true;
  return week.status === 'DRAFT' || week.isUnlocked === true;
}

// The route's client-trust boundary. Nothing this app sends carries an id or
// timesheetId today — draft.js emits five fields — but a row that arrived
// from the request already carrying one would pass straight through
// inheritIdentity() unchanged whenever it matches no filed row (inheritIdentity
// only ever ADDS an id, it never clears one), and Sphere360 would read that id
// as "update this row" for a filed row this app never looked up. Identity must
// be assigned only by inheritIdentity, from a filed row mergeWeek actually
// matched by key — never accepted from the request body.
function stripClientIdentity(entries) {
  return entries.map(({ id, timesheetId, ...rest }) => rest);
}

// The last check before a week-replacing write. mergeWeek trusts every filed
// row's workDate — client.js's normalizeEntry() only guarantees it is
// READABLE, never that it belongs to the week actually requested. If the API
// ever ignored `weekStart`, or unwrapWeek's single-wrapper assumption were ever
// wrong, a foreign-dated filed row would ride the union straight into a POST
// that replaces THIS week. Checked against the union, not the request, because
// it must cover every row going out — including filed rows the route itself
// never validated, not just the client-supplied ones.
//
// Returns the first offending workDate, or null when every row belongs to the
// week. A date, not a boolean: the caller's 409 must name what was wrong.
function foreignWorkDate(entries, dates) {
  for (const row of entries) {
    if (!dates.has(row.workDate)) return row.workDate;
  }
  return null;
}

module.exports = { entryKey, mergeWeek, weekWritable, stripClientIdentity, foreignWorkDate };
