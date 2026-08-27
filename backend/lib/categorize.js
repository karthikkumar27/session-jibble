const os = require('os');

// Windows and macOS ship case-insensitive filesystems by default; Linux does not.
// Injected rather than read inline so both branches are testable from one machine.
const DEFAULT_OPTIONS = {
  homeDir: os.homedir(),
  caseSensitive: process.platform !== 'win32' && process.platform !== 'darwin',
};

// Reduces every accepted path form to one comparable shape: forward slashes,
// no repeats, canonical drive letter, no trailing separator.
function normalizePath(p, opts = DEFAULT_OPTIONS) {
  if (typeof p !== 'string') return '';
  let out = p.trim();
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = opts.homeDir + out.slice(1);
  }
  out = out.replace(/\\/g, '/');   // backslashes -> forward slashes
  out = out.replace(/\/+/g, '/');  // collapse repeats; also flattens the UNC \\ leader
  if (/^[a-zA-Z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out;
}

// Segment-aware: "/a/bc" must not match the root "/a/b".
function matchesRoot(cwd, root, opts) {
  if (!root) return false;
  const a = opts.caseSensitive ? cwd : cwd.toLowerCase();
  const b = opts.caseSensitive ? root : root.toLowerCase();
  return a === b || a.startsWith(b + '/');
}

const CATEGORIES = ['work', 'nonWork'];

function classifyProject(cwd, config, options) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (typeof cwd !== 'string' || !cwd.trim()) return 'uncategorized';
  const target = normalizePath(cwd, opts);
  if (!target) return 'uncategorized';

  // Tier 1 — path rules. Longest match wins; work breaks a length tie.
  let best = null;
  for (const category of CATEGORIES) {
    for (const root of config?.[category]?.roots ?? []) {
      const r = normalizePath(root, opts);
      if (!matchesRoot(target, r, opts)) continue;
      if (best === null || r.length > best.length) {
        best = { category, length: r.length };
      }
      // Equal length can only happen for identical roots in opposing lists.
      // CATEGORIES puts work first, so the existing `best` already wins.
    }
  }
  if (best) return best.category;

  // Tier 2 — name rules. Always case-insensitive; a substring has no path depth
  // to rank by, so every path rule already outranks every name rule.
  const needle = target.toLowerCase();
  for (const category of CATEGORIES) {
    for (const fragment of config?.[category]?.contains ?? []) {
      if (typeof fragment !== 'string' || !fragment.trim()) continue;
      const frag = fragment.trim().replace(/\\/g, '/').toLowerCase();
      if (needle.includes(frag)) return category;
    }
  }

  return 'uncategorized';
}

module.exports = { DEFAULT_OPTIONS, normalizePath, matchesRoot, classifyProject };
