// The only module in this feature that touches the network.
//
// The token is read from the environment at CALL time, never captured at module
// load. Sphere360 bearers are short-lived, so the operator re-pastes into
// backend/.env mid-session and the very next request must pick it up without a
// server restart.

const { workDateOf } = require('./week');

const BASE_URL = 'https://sphere360.airasia.com';

// Update these two if Task 1's probe observed different paths.
const WEEK_PATH = '/api/timesheets';
const UPSERT_PATH = '/api/timesheets/upsert';

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status !== undefined) err.status = status;
  return err;
}

function readToken() {
  const token = (process.env.SPHERE360_TOKEN || '').trim();
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

function unwrapWeek(body) {
  // An empty array is a PROVEN empty week — the probe confirmed a resource with
  // no timesheet for the week returns []. This is the only body from which
  // "nothing is filed" may be inferred.
  if (Array.isArray(body) && body.length === 0) return { week: null, entries: [] };

  const week = Array.isArray(body) ? body[0] : body;
  if (week && typeof week === 'object' && Array.isArray(week.entries)) {
    return { week, entries: week.entries.map(normalizeEntry) };
  }

  // An empty week must otherwise be PROVEN, never inferred from a shape we do
  // not recognise. upsert replaces the whole week, so treating an unparseable
  // body as "nothing is filed" would let the next confirm wipe it.
  throw fail('SHAPE', 'Sphere360 returned a week in an unrecognised shape; refusing to treat it as empty');
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
