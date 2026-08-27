const { test } = require('node:test');
const assert = require('node:assert');
const { createClient } = require('../lib/sphere360/client');

// async + await on purpose: a synchronous try/finally around an async fn restores
// the environment BEFORE the awaited body runs, so every assertion inside would
// see the ambient token rather than the one under test.
const withToken = async (value, fn) => {
  const prev = process.env.SPHERE360_TOKEN;
  if (value === null) delete process.env.SPHERE360_TOKEN;
  else process.env.SPHERE360_TOKEN = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.SPHERE360_TOKEN;
    else process.env.SPHERE360_TOKEN = prev;
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
      fetchImpl: async (url, init) => { seen = { url, init }; return ok({ entries: [{ hours: 1 }] })(); },
    });
    const entries = await client.fetchWeek('2026-08-24T00:00:00.000Z');
    assert.equal(seen.init.headers.authorization, 'Bearer tok123');
    assert.match(seen.url, /2026-08-24T00%3A00%3A00.000Z|2026-08-24T00:00:00.000Z/);
    assert.deepEqual(entries, [{ hours: 1 }]);
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

test('accepts a bare array as the week', async () => {
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ok([{ hours: 2 }])() });
    assert.deepEqual(await client.fetchWeek('w'), [{ hours: 2 }]);
  });
});

test('accepts an entries envelope, including a genuinely empty week', async () => {
  await withToken('tok', async () => {
    const client = createClient({ fetchImpl: async () => ok({ entries: [] })() });
    assert.deepEqual(await client.fetchWeek('w'), []);
  });
});
