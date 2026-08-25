const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireLock, LOCK_FILE } = require('../lib/lock');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jibble-lock-'));
const alive = () => true;
const dead = () => false;

// C2: the SessionStart hook is global and fires across every repository, so two
// ingest runs overlapping is routine. Each would load the same ledger snapshot
// and append the same uuids — duplicates in an append-only store.
test('C2: a second acquire is refused while the lock is held', () => {
  const dir = tmpdir();
  const first = acquireLock(dir);
  assert.ok(first);
  assert.equal(acquireLock(dir), null);
  first.release();
});

test('C2: releasing lets the next run acquire', () => {
  const dir = tmpdir();
  acquireLock(dir).release();
  const second = acquireLock(dir);
  assert.ok(second);
  second.release();
});

test('release removes the lockfile', () => {
  const dir = tmpdir();
  const lock = acquireLock(dir);
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), true);
  lock.release();
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
});

test('acquireLock creates the ledger directory if it does not exist yet', () => {
  const dir = path.join(tmpdir(), 'nested', 'session-jibble');
  const lock = acquireLock(dir);
  assert.ok(lock);
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), true);
  lock.release();
});

test('a lock held by a dead process is reclaimed', () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 999999, at: Date.now() }));

  const lock = acquireLock(dir, 5 * 60 * 1000, dead);
  assert.ok(lock, 'a killed run must not block capture forever');
  lock.release();
});

test('a lock older than the stale window is reclaimed even if the pid looks alive', () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const now = 1_000_000_000;
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 1, at: now - 10 * 60 * 1000 }));

  const lock = acquireLock(dir, 5 * 60 * 1000, alive, () => now);
  assert.ok(lock);
  lock.release();
});

test('a fresh lock held by a live process is NOT reclaimed', () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const now = 1_000_000_000;
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 1, at: now - 1_000 }));

  assert.equal(acquireLock(dir, 5 * 60 * 1000, alive, () => now), null);
});

test('a corrupt lockfile is treated as abandoned rather than blocking forever', () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LOCK_FILE), '{ half-written');

  const lock = acquireLock(dir, 5 * 60 * 1000, alive);
  assert.ok(lock);
  lock.release();
});

test('release does not delete a lock another run has since taken over', () => {
  const dir = tmpdir();
  const mine = acquireLock(dir);
  // Simulate: mine was declared stale and a later run claimed the lock.
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 4242, at: Date.now() }));

  mine.release();
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')).pid, 4242);
});
