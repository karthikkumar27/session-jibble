// The only module in this feature that touches the network.
//
// The token is read from the environment at CALL time, never captured at module
// load. Sphere360 bearers are short-lived, so the operator re-pastes into
// backend/.env mid-session and the very next request must pick it up without a
// server restart.

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

function createClient({ fetchImpl = globalThis.fetch, baseUrl = BASE_URL } = {}) {
  const headers = () => ({
    authorization: `Bearer ${readToken()}`,
    'content-type': 'application/json',
  });

  return {
    async fetchWeek(weekStart) {
      const h = headers();
      const url = `${baseUrl}${WEEK_PATH}?weekStart=${encodeURIComponent(weekStart)}`;
      const res = await fetchImpl(url, { method: 'GET', headers: h });
      await assertOk(res);
      const body = await res.json();
      if (Array.isArray(body)) return body;
      if (body && Array.isArray(body.entries)) return body.entries;
      // An empty week must be PROVEN, never inferred from a shape we do not
      // recognise. upsert replaces the whole week, so treating an unparseable
      // body as "nothing is filed" would let the next confirm wipe it.
      throw fail('SHAPE', 'Sphere360 returned a week in an unrecognised shape; refusing to treat it as empty');
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
