// Reads SPHERE360_TOKEN from backend/.env fresh on every call.
//
// process.loadEnvFile() does NOT overwrite a process.env key that is already
// set, so a long-running server that loaded a token at boot keeps that exact
// value forever — a second loadEnvFile() after the operator rewrites the file
// is silently a no-op. Re-reading process.env at call time buys nothing when
// process.env itself is what is stale. The only way a rotated token is picked
// up without a restart is to read the file itself, on every call, here.
//
// Cached on the file's mtimeMs + size so a request that finds the file
// unchanged skips the read+parse; any edit changes at least one of those and
// is picked up on the very next call.

const fs = require('fs');
const path = require('path');

const DEFAULT_ENV_PATH = path.join(__dirname, '..', '..', '.env');

// client.js calls readToken() with no argument, so it always resolves through
// this indirection rather than the DEFAULT_ENV_PATH constant directly. That is
// what lets useEnvPathForTests() below redirect a parameterless call in tests
// without adding a parameter to client.js's frozen createClient() surface.
let activeDefaultPath = DEFAULT_ENV_PATH;

// { path, mtimeMs, size, value } — one slot is enough; this module only ever
// has one real caller (client.js), tests pass their own path explicitly.
let cache = null;

// Tolerant .env line parsing: blank lines and #-comments are skipped,
// whitespace around '=' is allowed, and a single pair of surrounding quotes
// is stripped. Returns null when no SPHERE360_TOKEN line exists at all (as
// opposed to one that exists but is blank), so the caller can tell "absent"
// from "present but empty".
function parseTokenLine(raw) {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'SPHERE360_TOKEN') continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    return value.trim();
  }
  return null;
}

function envFallback() {
  return (process.env.SPHERE360_TOKEN || '').trim();
}

// Never throws — an unreadable or absent file is a normal deployment shape
// (env-var-only deploys have no backend/.env at all), not an error. client.js
// owns turning "no token" into the NO_TOKEN error.
function readToken(envPath = activeDefaultPath) {
  let stat;
  try {
    stat = fs.statSync(envPath);
  } catch {
    cache = null;
    return envFallback();
  }

  if (
    cache &&
    cache.path === envPath &&
    cache.mtimeMs === stat.mtimeMs &&
    cache.size === stat.size
  ) {
    return cache.value;
  }

  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    cache = null;
    return envFallback();
  }

  const parsed = parseTokenLine(raw);
  const value = parsed === null ? envFallback() : parsed;

  cache = { path: envPath, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

// Test-only seam. client.js's createClient({fetchImpl?, baseUrl?}) is a frozen
// contract, so it has no way to hand readToken() a scratch path per test —
// this redirects what a bare readToken() call resolves to instead. Real
// callers (client.js, and this module's own default) never call it; only test
// setup does, so suites that exercise client.js are never coupled to whatever
// this machine's real backend/.env happens to hold. Pass no argument to
// restore the real default.
function useEnvPathForTests(p) {
  activeDefaultPath = p === undefined ? DEFAULT_ENV_PATH : p;
  cache = null;
}

module.exports = { readToken, DEFAULT_ENV_PATH, useEnvPathForTests };
