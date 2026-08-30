const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readToken } = require('../lib/sphere360/token');

const tmpEnvFile = (contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere360-token-'));
  const file = path.join(dir, '.env');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
};

// async + await on purpose, matching sphere360-client.test.js's withToken: a
// synchronous try/finally around an async fn restores process.env BEFORE the
// awaited body runs.
const withProcessEnvToken = async (value, fn) => {
  const prev = process.env.SPHERE360_TOKEN;
  if (value === null) delete process.env.SPHERE360_TOKEN;
  else process.env.SPHERE360_TOKEN = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.SPHERE360_TOKEN;
    else process.env.SPHERE360_TOKEN = prev;
  }
};

test('reads a token from a temp .env file', () => {
  const file = tmpEnvFile('SPHERE360_TOKEN=abc123\n');
  assert.equal(readToken(file), 'abc123');
});

// THE regression test. A process.env-snapshot implementation can only ever
// return whatever it read the first time — process.loadEnvFile() does not
// overwrite an already-set process.env key, so a real server would serve a
// rotated token's PREDECESSOR forever. Reading the file itself, on every
// call, is the only thing that makes this pass.
test('rewriting the file yields the NEW value on the next call', () => {
  const file = tmpEnvFile('SPHERE360_TOKEN=original-token\n');
  assert.equal(readToken(file), 'original-token');

  // A longer replacement changes both size and (almost always) mtime, so the
  // mtime/size cache cannot mistake this for the same file by coincidence.
  fs.writeFileSync(file, 'SPHERE360_TOKEN=brand-new-rotated-token\n');
  assert.equal(readToken(file), 'brand-new-rotated-token');
});

test('the mtime/size cache does not serve a stale value after a write', () => {
  const file = tmpEnvFile('SPHERE360_TOKEN=first-value\n');
  assert.equal(readToken(file), 'first-value');
  assert.equal(readToken(file), 'first-value'); // cache hit, still correct

  fs.writeFileSync(file, 'SPHERE360_TOKEN=second-value\n');
  assert.equal(readToken(file), 'second-value'); // cache must miss and re-read
  assert.equal(readToken(file), 'second-value'); // and re-cache the new value
});

test('skips blank lines and # comments', () => {
  const file = tmpEnvFile([
    '# Sphere360 credentials',
    '',
    '# rotated 2026-08-28',
    'SPHERE360_TOKEN=tok-with-comments',
    '',
  ].join('\n'));
  assert.equal(readToken(file), 'tok-with-comments');
});

test('tolerates whitespace around the "=" and surrounding the value', () => {
  const file = tmpEnvFile('SPHERE360_TOKEN   =   spaced-token   \n');
  assert.equal(readToken(file), 'spaced-token');
});

test('strips one pair of surrounding double quotes', () => {
  const file = tmpEnvFile('SPHERE360_TOKEN="quoted-token"\n');
  assert.equal(readToken(file), 'quoted-token');
});

test('strips one pair of surrounding single quotes', () => {
  const file = tmpEnvFile("SPHERE360_TOKEN='single-quoted-token'\n");
  assert.equal(readToken(file), 'single-quoted-token');
});

test('does not strip mismatched or internal quote characters', () => {
  const file = tmpEnvFile('SPHERE360_TOKEN="mismatched-quote\'\n');
  assert.equal(readToken(file), '"mismatched-quote\'');
});

test('a missing file falls back to process.env.SPHERE360_TOKEN', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere360-token-')), 'does-not-exist.env');
  await withProcessEnvToken('env-fallback-token', () => {
    assert.equal(readToken(file), 'env-fallback-token');
  });
});

test('a file with no SPHERE360_TOKEN line returns empty string when process.env is also unset', async () => {
  const file = tmpEnvFile('SOME_OTHER_VAR=irrelevant\n');
  await withProcessEnvToken(null, () => {
    assert.equal(readToken(file), '');
  });
});

test('a file with no SPHERE360_TOKEN line still falls back to process.env when set', async () => {
  const file = tmpEnvFile('SOME_OTHER_VAR=irrelevant\n');
  await withProcessEnvToken('fallback-because-no-line', () => {
    assert.equal(readToken(file), 'fallback-because-no-line');
  });
});

test('a present but blank SPHERE360_TOKEN line wins over process.env (no fallback)', async () => {
  // The line exists, so the file is authoritative even though its value is
  // empty — this is "present but empty", distinct from "line absent".
  const file = tmpEnvFile('SPHERE360_TOKEN=\n');
  await withProcessEnvToken('should-not-be-used', () => {
    assert.equal(readToken(file), '');
  });
});

test('an unreadable directory path falls back to process.env rather than throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere360-token-'));
  await withProcessEnvToken('fallback-on-error', () => {
    assert.doesNotThrow(() => readToken(dir));
    assert.equal(readToken(dir), 'fallback-on-error');
  });
});
