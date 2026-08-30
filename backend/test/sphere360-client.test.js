const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { createClient } = require('../lib/sphere360/client');
const { mergeWeek } = require('../lib/sphere360/merge');
const { useEnvPathForTests } = require('../lib/sphere360/token');

// client.js's readToken() now goes through lib/sphere360/token.js, which reads
// backend/.env off disk. That file is this developer's real, live Sphere360
// credential (see sphere360-token.test.js for the module's own file-reading
// coverage) — these tests must never touch it, so every call here is pointed
// at a path that provably does not exist, which sends token.js straight to
// its process.env fallback. That is what makes the token values below
// ('tok123', 'first', 'second', ...) the ones client.js actually sees.
const UNREACHABLE_ENV_PATH = path.join(__dirname, '.sphere360-token-test-unreachable.env');

// async + await on purpose: a synchronous try/finally around an async fn restores
// the environment BEFORE the awaited body runs, so every assertion inside would
// see the ambient token rather than the one under test.
const withToken = async (value, fn) => {
  const prev = process.env.SPHERE360_TOKEN;
  useEnvPathForTests(UNREACHABLE_ENV_PATH);
  if (value === null) delete process.env.SPHERE360_TOKEN;
  else process.env.SPHERE360_TOKEN = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.SPHERE360_TOKEN;
    else process.env.SPHERE360_TOKEN = prev;
    useEnvPathForTests();
  }
};

const ok = (body) => async () => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
});

test('refuses to call the network with no token', async () => {
  await withToken(null, async () => {
    const client = createClient({ fetchImpl: () => { throw new Error('must not be called'); } });
    await assert.rejects(() => client.fetchWeek('2026-08-24T00:00:00.000Z'), (e) => e.code === 'NO_TOKEN');
  });
});

test('treats a blank token as missing', async () => {
  await withToken('   ', async () => {
    const client = createClient({ fetchImpl: () => { throw new Error('must not be called'); } });
    await assert.rejects(() => client.upsertWeek({ weekStart: 'x', resourceId: 'r', entries: [] }),
      (e) => e.code === 'NO_TOKEN');
  });
});

test('sends the bearer header and returns parsed entries', async () => {
  await withToken('tok123', async () => {
    let seen;
    const client = createClient({
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return ok({ entries: [{ hours: 1, workDate: '2026-08-26' }] })();
      },
    });
    const { entries } = await client.fetchWeek('2026-08-24T00:00:00.000Z');
    assert.equal(seen.init.headers.authorization, 'Bearer tok123');
    assert.match(seen.url, /2026-08-24T00%3A00%3A00.000Z|2026-08-24T00:00:00.000Z/);
    assert.deepEqual(entries, [{ hours: 1, workDate: '2026-08-26' }]);
  });
});

test('reads the token at call time, so a rotated token needs no restart', async () => {
  // ONE client, constructed outside any token scope, called twice under different
  // tokens. Constructing a client per call would pass even if the token were read
  // at construction time — which is the whole property being asserted here.
  const headers = [];
  const client = createClient({
    fetchImpl: async (_url, init) => {
      headers.push(init.headers.authorization);
      return ok({ entries: [] })();
    },
  });

  await withToken('first', () => client.fetchWeek('w'));
  await withToken('second', () => client.fetchWeek('w'));

  assert.deepEqual(headers, ['Bearer first', 'Bearer second']);
});

test('maps 401 to a distinct, actionable auth error', async () => {
  await withToken('stale', async () => {
    const client = createClient({
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'expired' }),
    });
    await assert.rejects(() => client.fetchWeek('w'), (e) => {
      assert.equal(e.code, 'AUTH');
      assert.match(e.message, /backend\/\.env/);
      return true;
    });
  });
});

test('maps 403 to the same auth error as 401', async () => {
  await withToken('stale', async () => {
    const client = createClient({ fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }) });
    await assert.rejects(() => client.fetchWeek('w'), (e) => e.code === 'AUTH');
  });
});

test('surfaces the status on a server error', async () => {
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }) });
    await assert.rejects(() => client.fetchWeek('w'), (e) => e.code === 'HTTP' && e.status === 503);
  });
});

test('upsertWeek posts resourceId, weekStart and entries together', async () => {
  await withToken('tok', async () => {
    let body;
    const client = createClient({
      fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return ok({ ok: true })(); },
    });
    await client.upsertWeek({
      weekStart: '2026-08-24T00:00:00.000Z',
      resourceId: 'r1',
      entries: [{ projectId: '1', activityId: 'a', workDate: '2026-08-26', hours: 1, comments: 'c' }],
    });
    assert.equal(body.resourceId, 'r1');
    assert.equal(body.weekStart, '2026-08-24T00:00:00.000Z');
    assert.equal(body.entries.length, 1);
  });
});

test('never puts the token in an error message', async () => {
  await withToken('super-secret-token', async () => {
    const client = createClient({ fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) });
    await assert.rejects(() => client.fetchWeek('w'), (e) => {
      assert.ok(!e.message.includes('super-secret-token'));
      return true;
    });
  });
});

test('rejects a null JSON body rather than inventing an empty week', async () => {
  // An empty week must be PROVEN, never inferred. upsert REPLACES the week, so a
  // body we cannot parse must block the write, not report "nothing is filed".
  // The throw is coded ('SHAPE') so it stays inside the NO_TOKEN/AUTH/HTTP/SHAPE
  // error contract the POST route maps to statuses — never a bare TypeError.
  await withToken('tok', async () => {
    const client = createClient({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => null, text: async () => 'null' }),
    });
    await assert.rejects(() => client.fetchWeek('w'), (e) => e.code === 'SHAPE');
  });
});

test('rejects a string body rather than inventing an empty week', async () => {
  await withToken('tok', async () => {
    const client = createClient({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => 'no entries', text: async () => '"no entries"' }),
    });
    await assert.rejects(() => client.fetchWeek('w'), (e) => e.code === 'SHAPE');
  });
});

test('rejects an object whose entries key is absent — a paginated or renamed envelope', async () => {
  await withToken('tok', async () => {
    const client = createClient({
      fetchImpl: async () => ok({ data: [{ hours: 1 }], page: 1 })(),
    });
    await assert.rejects(() => client.fetchWeek('w'), (e) => e.code === 'SHAPE');
  });
});

test('rejects an object whose entries value is not an array', async () => {
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ok({ entries: { '0': { hours: 1 } } })() });
    await assert.rejects(() => client.fetchWeek('w'), (e) => e.code === 'SHAPE');
  });
});

test('accepts an entries envelope, including a genuinely empty week', async () => {
  await withToken('tok', async () => {
    const body = { entries: [] };
    const client = createClient({ fetchImpl: async () => ok(body)() });
    assert.deepEqual(await client.fetchWeek('w'), { week: body, entries: [] });
  });
});

// --- The observed envelope (probe, 2026-08-28) -------------------------------
// GET /api/timesheets returns an ARRAY OF WEEK OBJECTS, each carrying its
// entries nested under `.entries`. Every fixture below is built from that shape.

const filedEntry = {
  id: 'entry-1',
  timesheetId: 'ts-1',
  activityId: '78a50647-4a54-4264-83c0-7ab092c19c94',
  projectId: '1804361',
  workDate: '2026-08-26T00:00:00.000Z',
  hours: 1,
  comments: 'Daily scrum',
  activity: { isBillable: true },
  isBillable: true,
};

const weekWrapper = (overrides = {}) => ({
  id: 'ts-1',
  resourceId: 'res-1',
  weekStart: '2026-08-24T00:00:00.000Z',
  status: 'DRAFT',
  submittedAt: null,
  approvedAt: null,
  approvedBy: null,
  remarks: null,
  isUnlocked: false,
  resource: { id: 'res-1' },
  entries: [filedEntry],
  ...overrides,
});

test('unwraps the observed envelope to the NESTED entries, not the week wrappers', async () => {
  // The D1 regression. `Array.isArray(body) ? body : …` took the first branch —
  // the body IS an array, just of week objects — so `filed` became one wrapper
  // with no workDate and no hours. The SHAPE guard never fired, because an
  // array is a legitimate shape. mergeWeek would then post that wrapper back
  // as if it were an entry, into an endpoint that replaces the whole week.
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ok([weekWrapper()])() });
    const { week, entries } = await client.fetchWeek('w');

    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'entry-1');
    assert.equal(entries[0].hours, 1);
    // The wrapper must never appear among the entries.
    assert.ok(!entries.some(e => Array.isArray(e.entries)), 'a week wrapper leaked into entries');
    assert.equal(week.status, 'DRAFT');
    assert.equal(week.isUnlocked, false);
  });
});

test('an empty array is a genuinely empty week, not an unparseable one', async () => {
  // The probe confirmed a week with no timesheet returns []. That is a proven
  // "nothing filed", so it must NOT be refused the way an unknown shape is.
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ok([])() });
    assert.deepEqual(await client.fetchWeek('w'), { week: null, entries: [] });
  });
});

test('tolerates a bare week object as the body', async () => {
  await withToken('tok', async () => {
    const body = weekWrapper();
    const client = createClient({ fetchImpl: async () => ok(body)() });
    const { week, entries } = await client.fetchWeek('w');
    assert.equal(week, body);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'entry-1');
  });
});

test('refuses an array whose first element is not a week wrapper', async () => {
  // A bare array of entry-shaped rows was accepted before D1 and is exactly how
  // the bug hid. If the API ever changes back, that is a shape change we must
  // see, not silently absorb — the next confirm replaces the whole week.
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ok([{ hours: 2, workDate: '2026-08-26' }])() });
    await assert.rejects(() => client.fetchWeek('w'), (e) => e.code === 'SHAPE');
  });
});

test('refuses more than one week wrapper for a single week request', async () => {
  // One `weekStart` query must return at most one week. The old `body[0]` took
  // the first wrapper unconditionally — if the API ever ignored the query, or
  // returned neighbouring weeks too, this would silently pick one and drop the
  // rest, and the dropped wrapper's rows would never even reach mergeWeek's
  // own protections.
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ok([weekWrapper(), weekWrapper({ id: 'ts-2' })])() });
    await assert.rejects(() => client.fetchWeek('w'), (e) => {
      assert.equal(e.code, 'SHAPE');
      assert.match(e.message, /2/);
      return true;
    });
  });
});

test('normalises every filed workDate on read, so a filed row can be collided with', async () => {
  // The D2 regression, end to end. The API returns workDate as an instant and
  // accepts a bare date on write; entryKey compares verbatim. Un-normalised,
  // the drafted row below matches nothing, mergeWeek keeps the filed row AND
  // appends the drafted one, and the confirm files the same hour twice.
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ok([weekWrapper()])() });
    const { entries } = await client.fetchWeek('w');
    assert.equal(entries[0].workDate, '2026-08-26');

    const drafted = {
      projectId: '1804361',
      activityId: '78a50647-4a54-4264-83c0-7ab092c19c94',
      workDate: '2026-08-26',
      hours: 2,
      comments: 'Daily scrum',
    };
    const { entries: union, replaced } = mergeWeek({ filed: entries, drafted: [drafted] });
    assert.equal(replaced.length, 1, 'the filed instant did not collide with the drafted date');
    assert.equal(union.length, 1, 'the same work was filed twice');
  });
});

test('refuses a filed row whose workDate cannot be read', async () => {
  // Coded SHAPE, not a bare TypeError: an unreadable workDate means the row
  // cannot be keyed, and an unkeyable filed row is one mergeWeek cannot protect
  // from a week-replacing POST. It must block the write through the same
  // NO_TOKEN/AUTH/HTTP/SHAPE contract the POST route maps to statuses.
  await withToken('tok', async () => {
    const bad = weekWrapper({ entries: [{ ...filedEntry, workDate: 'last Tuesday' }] });
    const client = createClient({ fetchImpl: async () => ok([bad])() });
    await assert.rejects(() => client.fetchWeek('w'), (e) => e.code === 'SHAPE');
  });
});

test('normalisation leaves every other field on a filed row untouched', async () => {
  // D3 depends on this: id, timesheetId, isBillable and activity must survive
  // the read, or the round trip strips them from rows we did not author.
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ok([weekWrapper()])() });
    const { entries } = await client.fetchWeek('w');
    assert.deepEqual(entries[0], { ...filedEntry, workDate: '2026-08-26' });
  });
});
