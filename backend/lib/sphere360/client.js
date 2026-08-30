// The only module in this feature that touches the network.
//
// The token is read from backend/.env at CALL time, never captured at module
// load or cached in process.env. Sphere360 bearers are short-lived, so the
// operator re-pastes into backend/.env mid-session — and process.loadEnvFile()
// does not overwrite an already-set process.env key, so a process.env-based
// read would keep serving whatever token the server loaded at boot forever.
// Delegating to lib/sphere360/token.js, which re-reads the file itself (cached
// on its mtime/size), is what actually makes the very next request pick up a
// rotated token without a server restart.

const { workDateOf } = require('./week');
const { readToken: tokenReader } = require('./token');

const BASE_URL = 'https://sphere360.airasia.com';

// Update these two if Task 1's probe observed different paths.
const WEEK_PATH = '/api/timesheets';
const UPSERT_PATH = '/api/timesheets/upsert';
const PLAN_PATH = '/api/capacity-planning/plan-vs-actual';

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status !== undefined) err.status = status;
  return err;
}

function readToken() {
  const token = tokenReader();
  if (!token) {
    throw fail('NO_TOKEN', 'SPHERE360_TOKEN is not set. Add it to backend/.env and retry.');
  }
  return token;
}

// Error bodies are echoed back to the operator, so they must never carry the
// credential. Only the status and a short body excerpt are surfaced.
async function assertOk(res) {
  if (res.ok) return;
  const body = (await res.text().catch(() => '')).slice(0, 200);
  if (res.status === 401 || res.status === 403) {
    throw fail('AUTH', 'Sphere360 rejected the token — refresh SPHERE360_TOKEN in backend/.env', res.status);
  }
  throw fail('HTTP', `Sphere360 returned ${res.status}${body ? `: ${body}` : ''}`, res.status);
}

// workDate is normalised here, at the edge, so nothing downstream ever sees an
// instant: the API returns '2026-08-26T00:00:00.000Z' but accepts '2026-08-26'
// on write, and entryKey compares the field verbatim. One un-normalised row is
// a collision the merge cannot see and a duplicate the operator did not ask
// for. Every other field is carried through untouched — id, timesheetId,
// isBillable and activity belong to rows this app did not author, and the
// round trip must return them exactly as they arrived.
//
// A workDate we cannot read is refused as SHAPE rather than allowed through
// unkeyable: it stays inside the NO_TOKEN/AUTH/HTTP/SHAPE contract the POST
// route maps to statuses, and it blocks the write instead of risking one.
function normalizeEntry(entry) {
  try {
    return { ...entry, workDate: workDateOf(entry?.workDate) };
  } catch (err) {
    throw fail('SHAPE', `Sphere360 returned an entry with an unreadable workDate: ${err.message}`);
  }
}

// The probe of 2026-08-28 settled the envelope: this endpoint returns an ARRAY
// OF WEEK OBJECTS, each carrying its rows nested under `.entries` — never an
// array of entries. The old `Array.isArray(body) ? body : ...` took the first
// branch and handed week wrappers back as if they were entries, and the SHAPE
// guard could not catch it, because an array IS a legitimate shape. A shape
// guard only helps against shapes it can tell apart.
//
// Returns the week metadata alongside the entries rather than the entries
// alone: only the wrapper carries `status`/`isUnlocked`, and the write path
// must refuse a week that is not writable.
function unwrapWeek(body) {
  // An empty array is a PROVEN empty week — the probe confirmed a resource with
  // no timesheet for the week returns []. This is the only body from which
  // "nothing is filed" may be inferred.
  if (Array.isArray(body) && body.length === 0) return { week: null, entries: [] };

  // One `weekStart` query must return at most one week. The old `body[0]` took
  // the first wrapper unconditionally: if the API ever ignored the query, or
  // returned neighbouring weeks too, this would silently pick one and drop the
  // rest — and the dropped wrapper's rows never even reach mergeWeek's own
  // protections. A count we cannot make sense of is refused, not guessed at.
  if (Array.isArray(body) && body.length > 1) {
    throw fail('SHAPE', `Sphere360 returned ${body.length} week wrappers for one week request; refusing to guess which is correct`);
  }

  const week = Array.isArray(body) ? body[0] : body;
  if (week && typeof week === 'object' && Array.isArray(week.entries)) {
    return { week, entries: week.entries.map(normalizeEntry) };
  }

  // An empty week must otherwise be PROVEN, never inferred from a shape we do
  // not recognise. upsert replaces the whole week, so treating an unparseable
  // body as "nothing is filed" would let the next confirm wipe it.
  throw fail('SHAPE', 'Sphere360 returned a week in an unrecognised shape; refusing to treat it as empty');
}

// The capacity-planning endpoint, which answers "how many mandays is this
// person planned for on each project this month".
//
// It speaks CALENDAR months — its own months[].workingDays reports 22 for
// September while the timesheet cycle 26 Aug - 25 Sep has 23. That field is
// dropped here rather than passed on: two working-day counts on one card is a
// contradiction the operator cannot resolve, and cycle.js computes the one
// that matches the timesheet. Only the allocations survive.
//
// months[i] inside an allocation is positional against the top-level months
// array, so a single-month query puts this month's plan at months[0]. If the
// body ever carries more than the one month asked for — a widened range, an
// ignored query — months[0] is some OTHER month's figure and is
// indistinguishable from the right answer once rendered. That is refused, not
// guessed at, exactly as unwrapWeek refuses two week wrappers.
//
// An unrecognised body throws SHAPE rather than yielding an empty list, for
// the same reason an unparseable week is not "nothing filed": an operator with
// a 17-manday commitment would be shown a card saying they have none.
function unwrapPlan(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw fail('SHAPE', 'Sphere360 returned a plan-vs-actual body in an unrecognised shape');
  }
  if (!Array.isArray(body.allocations)) {
    throw fail('SHAPE', 'Sphere360 returned a plan-vs-actual body with no allocations array');
  }
  if (Array.isArray(body.months) && body.months.length > 1) {
    throw fail('SHAPE', `Sphere360 returned ${body.months.length} months for a single-month plan query; refusing to guess which column is this cycle's`);
  }

  const allocations = [];
  for (const a of body.allocations) {
    const planned = Array.isArray(a?.months) ? a.months[0] : undefined;
    if (typeof planned !== 'number' || !Number.isFinite(planned)) {
      throw fail('SHAPE', `Sphere360 returned an allocation with an unreadable month value: ${JSON.stringify(a?.months)}`);
    }
    // portfolioMandays is the project's whole-life allocation (149.7 observed)
    // and is NOT this month's plan; taking it would overstate the commitment
    // nearly tenfold. Only the month column is read.
    if (planned === 0) continue;     // listed but not planned this month
    allocations.push({
      projectId: a.projectId,
      projectCode: a.projectCode,
      project: a.project,
      projectStatus: a.projectStatus,
      plannedMandays: planned,
    });
  }
  return { allocations };
}

function createClient({ fetchImpl = globalThis.fetch, baseUrl = BASE_URL } = {}) {
  const headers = () => ({
    authorization: `Bearer ${readToken()}`,
    'content-type': 'application/json',
  });

  return {
    // -> { week: object|null, entries: array }
    async fetchWeek(weekStart) {
      const h = headers();
      const url = `${baseUrl}${WEEK_PATH}?weekStart=${encodeURIComponent(weekStart)}`;
      const res = await fetchImpl(url, { method: 'GET', headers: h });
      await assertOk(res);
      return unwrapWeek(await res.json());
    },

    // -> { allocations: [{ projectId, projectCode, project, projectStatus, plannedMandays }] }
    // Read-only, and queried for exactly one month at a time so months[0] is
    // unambiguous.
    async fetchPlanVsActual(monthKey) {
      const h = headers();
      const key = encodeURIComponent(monthKey);
      const res = await fetchImpl(`${baseUrl}${PLAN_PATH}?from=${key}&to=${key}`, { method: 'GET', headers: h });
      await assertOk(res);
      return unwrapPlan(await res.json());
    },

    // No retry, ever. This endpoint replaces a week; a retried POST after an
    // ambiguous failure can overwrite a state the operator has not seen.
    async upsertWeek({ weekStart, resourceId, entries }) {
      const h = headers();
      const res = await fetchImpl(`${baseUrl}${UPSERT_PATH}`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ resourceId, weekStart, entries }),
      });
      await assertOk(res);
      return res.json().catch(() => ({}));
    },
  };
}

module.exports = { createClient, BASE_URL };
