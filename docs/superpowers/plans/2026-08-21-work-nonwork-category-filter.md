# Work / Non-work Category Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user classify their Claude Code project folders as work or non-work, and filter the dashboard's KPI cards, hours chart, and session table by that classification.

**Architecture:** Classification happens backend-side in a pure, dependency-injected resolver so the chart never re-sums rounded per-session values. Rules live in a per-user JSON file edited through a Settings sheet. The frontend holds one `CategoryFilterValue` in `App.tsx` and passes it to four consumers.

**Tech Stack:** Node 20+ / Express 5 (backend, CommonJS), `node:test` for backend tests, React 19 + TypeScript + Vite 8, Tailwind 3, Radix UI, Recharts.

**Spec:** `docs/superpowers/specs/2026-08-20-work-nonwork-category-filter-design.md`

## Global Constraints

- **Three categories only:** `work`, `nonWork`, `uncategorized`. These exact string literals are used in the config file, both APIs, and the frontend types — never `personal`, never `non-work` as an identifier.
- **User-facing label for `nonWork` is `Non-work`** (capital N, lowercase w, hyphen). Never "Personal".
- **Never use `toISOString()` for date labels** anywhere. Both sides derive `YYYY-MM-DD` from the local clock. This is pre-existing project law — see `CLAUDE.md`.
- **Do not change `GAP_THRESHOLD`** (30 min) or `attributeGap()`. Their output must be byte-identical after this change.
- **`GET /api/daily-stats` `hours` field must keep its exact current value.** New category fields are added alongside it, never replacing it.
- **Path comparison is case-insensitive on `win32` and `darwin`, case-sensitive elsewhere.** Platform behaviour is passed in as an option, never read from `process.platform` inside a resolver function.
- **Config path:** `~/.claude/session-jibble.config.json`. Config version is `1`.
- **Backend is CommonJS** (`require`/`module.exports`). Frontend is ESM + TypeScript.
- **No new frontend state library.** `useState`/`useEffect` only. The one permitted new frontend dependency in this plan is `@radix-ui/react-dialog`.
- **Chart fills:** All/Work `hsl(222.2 47.4% 11.2%)` (the existing `BAR_FILL`), Non-work `hsl(262 60% 48%)`, Uncategorized `hsl(215 20% 45%)`.
- **No `animate-in` / `animate-out` Tailwind classes** — `tailwindcss-animate` is not installed in this project.

### Deviation from the spec, deliberate

The spec says `classifyProject` "lives in `server.js` ... and is exported for tests". It cannot: `server.js` calls `app.listen()` at module scope, so `require`-ing it from a test would bind port 8089. The resolver goes in `backend/lib/categorize.js` instead. Everything else about it is as specified.

## File Structure

**Backend**

| File | Responsibility |
|---|---|
| `backend/lib/categorize.js` (new) | Path normalization + `classifyProject`. Pure, no `fs`, no Express |
| `backend/lib/config.js` (new) | Config load / validate / atomic save. Owns the config file path and schema |
| `backend/test/categorize.test.js` (new) | `node:test` suite for the resolver, both platform option sets |
| `backend/test/config.test.js` (new) | `node:test` suite for validation and the save/load round-trip |
| `backend/server.js` (modify) | Wires the two modules into five endpoints |
| `backend/package.json` (modify) | Adds a `test` script |

**Frontend**

| File | Responsibility |
|---|---|
| `frontend/src/lib/types.ts` (modify) | `Category`, `CategoryFilterValue`, config and project row shapes |
| `frontend/src/components/CategoryFilter.tsx` (new) | The segmented All/Work/Non-work/Uncategorized control. Presentational only |
| `frontend/src/components/ui/sheet.tsx` (new) | Radix Dialog wrapper styled as a side sheet |
| `frontend/src/components/SettingsPanel.tsx` (new) | The rule editor. Owns its own draft state and save lifecycle |
| `frontend/src/App.tsx` (modify) | Owns filter state, URL sync, config/project fetching |
| `frontend/src/components/HoursChart.tsx` (modify) | Category-aware field and fill selection |
| `frontend/src/components/TodayCards.tsx` (modify) | Category-aware hours and counts |
| `frontend/src/components/SessionsTable.tsx` (modify) | Category filter applied before the date filter |
| `frontend/src/lib/exportJson.ts` (modify) | Category stamped into the payload |

---

### Task 1: Cross-platform resolver

**Files:**
- Create: `backend/lib/categorize.js`
- Create: `backend/test/categorize.test.js`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULT_OPTIONS: { homeDir: string, caseSensitive: boolean }`
  - `normalizePath(p: string, opts?) => string`
  - `classifyProject(cwd: string, config: object, options?) => 'work' | 'nonWork' | 'uncategorized'`
  - `config` is `{ work: { roots: string[], contains: string[] }, nonWork: {...} }`. Missing keys must be tolerated — this function is called with half-built config objects during validation.

- [ ] **Step 1: Add the test script**

In `backend/package.json`, add to `"scripts"`:

```json
"test": "node --test test/"
```

- [ ] **Step 2: Write the failing test**

Create `backend/test/categorize.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyProject, normalizePath } = require('../lib/categorize');

// Three option sets so both filesystem behaviours are exercised from one machine.
const LINUX = { homeDir: '/home/dev', caseSensitive: true };
const MAC   = { homeDir: '/home/dev', caseSensitive: false };
const WIN   = { homeDir: 'C:\\Users\\dev', caseSensitive: false };

// Builds a full config so classifyProject never sees undefined lists by accident.
const cfg = (work = {}, nonWork = {}) => ({
  work:    { roots: [], contains: [], ...work },
  nonWork: { roots: [], contains: [], ...nonWork },
});

test('normalizePath converts backslashes and collapses repeats', () => {
  assert.equal(normalizePath('C:\\Users\\dev\\proj', WIN), 'C:/Users/dev/proj');
  assert.equal(normalizePath('\\\\server\\share\\proj', WIN), '/server/share/proj');
});

test('normalizePath upper-cases the drive letter', () => {
  assert.equal(normalizePath('c:/work', WIN), 'C:/work');
});

test('normalizePath expands ~ with either separator', () => {
  assert.equal(normalizePath('~/work', LINUX), '/home/dev/work');
  assert.equal(normalizePath('~\\work', WIN), 'C:/Users/dev/work');
});

test('normalizePath strips a trailing separator but keeps a bare root', () => {
  assert.equal(normalizePath('~/work/', LINUX), '/home/dev/work');
  assert.equal(normalizePath('/', LINUX), '/');
});

test('root matching is segment-aware', () => {
  const c = cfg({ roots: ['~/gitlab-projects'] });
  assert.equal(classifyProject('/home/dev/gitlab-projects/api', c, LINUX), 'work');
  assert.equal(classifyProject('/home/dev/gitlab-projects-archive/api', c, LINUX), 'uncategorized');
});

test('a cwd exactly equal to a root matches it', () => {
  const c = cfg({ roots: ['~/gitlab-projects'] });
  assert.equal(classifyProject('/home/dev/gitlab-projects', c, LINUX), 'work');
});

test('longest matching root wins, so a nested exception works', () => {
  const c = cfg({ roots: ['~/gitlab-projects'] }, { roots: ['~/gitlab-projects/test-mcp'] });
  assert.equal(classifyProject('/home/dev/gitlab-projects/skyiq-web', c, LINUX), 'work');
  assert.equal(classifyProject('/home/dev/gitlab-projects/test-mcp/ticker', c, LINUX), 'nonWork');
});

test('path rules outrank name rules', () => {
  const c = cfg({ contains: ['skyiq'] }, { roots: ['~/side'] });
  assert.equal(classifyProject('/home/dev/side/skyiq-toy', c, LINUX), 'nonWork');
});

test('equal-length roots in opposing lists resolve to work', () => {
  const c = cfg({ roots: ['~/shared'] }, { roots: ['~/shared'] });
  assert.equal(classifyProject('/home/dev/shared/x', c, LINUX), 'work');
});

test('name rules are case-insensitive and separator-normalized', () => {
  const c = cfg({ contains: ['projects\\skyiq'] });
  assert.equal(classifyProject('C:\\Projects\\SkyIQ-web', c, WIN), 'work');
});

test('windows paths match regardless of separator or drive case', () => {
  const c = cfg({ roots: ['c:/work'] });
  assert.equal(classifyProject('C:\\work\\proj', c, WIN), 'work');
  assert.equal(classifyProject('C:/work/proj', c, WIN), 'work');
});

test('UNC paths match a root written in either form', () => {
  const c = cfg({ roots: ['\\\\server\\share'] });
  assert.equal(classifyProject('\\\\server\\share\\proj', c, WIN), 'work');
});

// The assertion that would otherwise regress silently.
test('casing differences match on mac/windows but not on linux', () => {
  const c = cfg({ roots: ['~/work'] });
  const cwd = '/home/dev/Work/proj';
  assert.equal(classifyProject(cwd, c, MAC), 'work');
  assert.equal(classifyProject(cwd, c, LINUX), 'uncategorized');
});

test('empty inputs are uncategorized, never a crash', () => {
  assert.equal(classifyProject('', cfg(), LINUX), 'uncategorized');
  assert.equal(classifyProject('/home/dev/x', cfg(), LINUX), 'uncategorized');
  assert.equal(classifyProject('/home/dev/x', {}, LINUX), 'uncategorized');
  assert.equal(classifyProject(undefined, cfg(), LINUX), 'uncategorized');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `Cannot find module '../lib/categorize'`

- [ ] **Step 4: Write the implementation**

Create `backend/lib/categorize.js`:

```js
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

module.exports = { DEFAULT_OPTIONS, normalizePath, classifyProject };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS — 14 tests, 0 failures

- [ ] **Step 6: Commit**

```bash
git add backend/lib/categorize.js backend/test/categorize.test.js backend/package.json
git commit -m "feat(backend): add cross-platform project categorization resolver"
```

---

### Task 2: Config load, validate, save

**Files:**
- Create: `backend/lib/config.js`
- Create: `backend/test/config.test.js`

**Interfaces:**
- Consumes: `normalizePath` from `backend/lib/categorize.js`.
- Produces:
  - `CONFIG_FILE: string`, `CONFIG_VERSION: 1`, `DEFAULT_CONFIG: object`
  - `validateConfig(raw) => { config: object | null, errors: { path: string, message: string }[] }`
  - `loadConfig(file?) => { config, source: 'file' | 'defaults', error: string | null }`
  - `saveConfig(config, file?) => void`
  - `isUnconfigured(config) => boolean`
  - `loadConfig` and `saveConfig` take an optional file path so tests never touch the real `~/.claude`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/config.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_CONFIG, validateConfig, loadConfig, saveConfig, isUnconfigured,
} = require('../lib/config');

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sj-cfg-')), 'config.json');

const valid = {
  version: 1,
  work:    { roots: ['~/gitlab-projects'], contains: ['skyiq'] },
  nonWork: { roots: ['~/side'], contains: [] },
};

test('accepts a well-formed config', () => {
  const { config, errors } = validateConfig(valid);
  assert.deepEqual(errors, []);
  assert.deepEqual(config.work.roots, ['~/gitlab-projects']);
  assert.equal(config.version, 1);
});

test('accepts posix, drive, UNC and ~ roots', () => {
  const { errors } = validateConfig({
    version: 1,
    work: { roots: ['/srv/work', 'C:\\work', 'C:/work2', '\\\\server\\share', '~/w'], contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.deepEqual(errors, []);
});

test('rejects a relative root with a field path', () => {
  const { config, errors } = validateConfig({
    version: 1,
    work: { roots: ['projects/thing'], contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.equal(config, null);
  assert.equal(errors[0].path, 'work.roots[0]');
});

test('rejects an empty-string entry', () => {
  const { errors } = validateConfig({
    version: 1,
    work: { roots: ['   '], contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.equal(errors[0].path, 'work.roots[0]');
});

test('rejects the same root in both lists', () => {
  const { config, errors } = validateConfig({
    version: 1,
    work: { roots: ['~/shared'], contains: [] },
    nonWork: { roots: ['~/shared'], contains: [] },
  });
  assert.equal(config, null);
  assert.equal(errors[0].path, 'nonWork.roots[0]');
});

test('dedupes within a list without erroring', () => {
  const { config, errors } = validateConfig({
    version: 1,
    work: { roots: ['~/w', '~/w/'], contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.deepEqual(errors, []);
  assert.equal(config.work.roots.length, 1);
});

test('rejects a list over 200 entries', () => {
  const { errors } = validateConfig({
    version: 1,
    work: { roots: Array.from({ length: 201 }, (_, i) => `/r${i}`), contains: [] },
    nonWork: { roots: [], contains: [] },
  });
  assert.equal(errors[0].path, 'work.roots');
});

test('missing file yields defaults, not an error', () => {
  const r = loadConfig(path.join(os.tmpdir(), 'sj-does-not-exist.json'));
  assert.equal(r.source, 'defaults');
  assert.equal(r.error, null);
  assert.deepEqual(r.config, DEFAULT_CONFIG);
});

test('malformed JSON yields defaults with a surfaced error', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not json');
  const r = loadConfig(f);
  assert.equal(r.source, 'defaults');
  assert.match(r.error, /parse/i);
});

test('unknown version yields defaults with a surfaced error', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ ...valid, version: 99 }));
  const r = loadConfig(f);
  assert.equal(r.source, 'defaults');
  assert.match(r.error, /version/i);
});

test('save then load round-trips and drops unknown keys', () => {
  const f = tmpFile();
  saveConfig({ ...valid, bogus: true }, f);
  const r = loadConfig(f);
  assert.equal(r.source, 'file');
  assert.equal(r.error, null);
  assert.equal(r.config.bogus, undefined);
  assert.deepEqual(r.config.work.contains, ['skyiq']);
});

test('save leaves no temp file behind', () => {
  const f = tmpFile();
  saveConfig(valid, f);
  assert.equal(fs.existsSync(`${f}.tmp`), false);
});

test('isUnconfigured is true only when all four lists are empty', () => {
  assert.equal(isUnconfigured(DEFAULT_CONFIG), true);
  assert.equal(isUnconfigured(valid), false);
  assert.equal(isUnconfigured({
    version: 1, work: { roots: [], contains: ['x'] }, nonWork: { roots: [], contains: [] },
  }), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `Cannot find module '../lib/config'`

- [ ] **Step 3: Write the implementation**

Create `backend/lib/config.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizePath } = require('./categorize');

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'session-jibble.config.json');
const CONFIG_VERSION = 1;
const MAX_ENTRIES = 200;

// Empty on purpose: seeding one person's folder layout would be wrong for
// everyone else on the team. The UI handles the empty case explicitly.
const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  work: { roots: [], contains: [] },
  nonWork: { roots: [], contains: [] },
};

// Absolute in any accepted form: posix, drive-with-separator, UNC, or ~.
const ABSOLUTE_RE = /^(\/|[a-zA-Z]:[\\/]|\\\\|~($|[\\/]))/;

const CATEGORIES = ['work', 'nonWork'];
const FIELDS = ['roots', 'contains'];

function isUnconfigured(config) {
  return CATEGORIES.every(c =>
    (config?.[c]?.roots?.length ?? 0) === 0 &&
    (config?.[c]?.contains?.length ?? 0) === 0
  );
}

function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: null, errors: [{ path: '', message: 'Config must be an object' }] };
  }

  const errors = [];
  const out = {
    version: CONFIG_VERSION,
    work: { roots: [], contains: [] },
    nonWork: { roots: [], contains: [] },
  };

  for (const category of CATEGORIES) {
    const section = raw[category];
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      errors.push({ path: category, message: `"${category}" must be an object with roots and contains` });
      continue;
    }
    for (const field of FIELDS) {
      const list = section[field];
      if (!Array.isArray(list)) {
        errors.push({ path: `${category}.${field}`, message: `"${field}" must be an array` });
        continue;
      }
      if (list.length > MAX_ENTRIES) {
        errors.push({ path: `${category}.${field}`, message: `At most ${MAX_ENTRIES} entries allowed` });
        continue;
      }
      const seen = new Set();
      list.forEach((entry, i) => {
        const at = `${category}.${field}[${i}]`;
        if (typeof entry !== 'string' || !entry.trim()) {
          errors.push({ path: at, message: 'Must be a non-empty string' });
          return;
        }
        const value = entry.trim();
        if (field === 'roots' && !ABSOLUTE_RE.test(value)) {
          errors.push({
            path: at,
            message: 'Must start with ~ or be absolute (/path, C:\\path, \\\\server\\share)',
          });
          return;
        }
        // Dedupe silently — a repeated entry is noise, not a mistake worth blocking on.
        const key = field === 'roots' ? normalizePath(value).toLowerCase() : value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out[category][field].push(value);
      });
    }
  }

  // A root in both lists is always a mistake, and the length tiebreak would hide it.
  const workKeys = new Set(out.work.roots.map(r => normalizePath(r).toLowerCase()));
  out.nonWork.roots.forEach((r, i) => {
    if (workKeys.has(normalizePath(r).toLowerCase())) {
      errors.push({
        path: `nonWork.roots[${i}]`,
        message: `"${r}" is also listed under work folders — a folder cannot be both`,
      });
    }
  });

  return { config: errors.length ? null : out, errors };
}

function loadConfig(file = CONFIG_FILE) {
  const fallback = (error) => ({ config: DEFAULT_CONFIG, source: 'defaults', error });

  if (!fs.existsSync(file)) return fallback(null);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback(`Could not parse ${file}: ${err.message}`);
  }

  if (raw?.version !== CONFIG_VERSION) {
    return fallback(
      `Unsupported config version ${JSON.stringify(raw?.version)} in ${file}; expected ${CONFIG_VERSION}`
    );
  }

  const { config, errors } = validateConfig(raw);
  if (!config) {
    return fallback(`Invalid config in ${file}: ${errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
  }
  return { config, source: 'file', error: null };
}

// Temp-then-rename: rename is atomic on POSIX, so a concurrent reader sees
// either the whole old file or the whole new one, never a truncated one.
function saveConfig(config, file = CONFIG_FILE) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = {
  CONFIG_FILE, CONFIG_VERSION, DEFAULT_CONFIG,
  validateConfig, loadConfig, saveConfig, isUnconfigured,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS — 27 tests total across both files (14 resolver + 13 config), 0 failures

- [ ] **Step 5: Commit**

```bash
git add backend/lib/config.js backend/test/config.test.js
git commit -m "feat(backend): add per-user category config load, validate and atomic save"
```

---

### Task 3: Config and projects endpoints

**Files:**
- Modify: `backend/server.js` — imports at top, new routes before `app.listen`

**Interfaces:**
- Consumes: everything exported by `backend/lib/config.js` and `classifyProject` from `backend/lib/categorize.js`.
- Produces:
  - `GET /api/config` → `{ config, source, error, unconfigured }`
  - `PUT /api/config` → same shape on 200, `{ errors: [{path, message}] }` on 400
  - `GET /api/projects` → `{ path, displayPath, category, hours, sessions }[]`

- [ ] **Step 1: Add the imports**

In `backend/server.js`, directly below the existing `const os = require('os');` line:

```js
const { classifyProject } = require('./lib/categorize');
const {
  loadConfig, saveConfig, validateConfig, isUnconfigured,
} = require('./lib/config');
```

- [ ] **Step 2: Add the three routes**

In `backend/server.js`, immediately above the `const PORT = 8089;` line:

```js
app.get('/api/config', (req, res) => {
  try {
    const { config, source, error } = loadConfig();
    res.json({ config, source, error, unconfigured: isUnconfigured(config) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const { config, errors } = validateConfig(req.body);
    if (!config) return res.status(400).json({ errors });
    saveConfig(config);
    res.json({ config, source: 'file', error: null, unconfigured: isUnconfigured(config) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Every distinct project folder in history with its resolved category. Powers the
// Settings panel's Uncategorized list, so hours are all-time rather than the
// chart's 30-day window — this list is for deciding how a folder should be filed.
app.get('/api/projects', (req, res) => {
  try {
    const { config } = loadConfig();
    const groups = groupSessionsFromHistory(readHistory());
    const byPath = {};

    for (const { project, timestamps } of Object.values(groups)) {
      if (!project) continue;
      if (!byPath[project]) byPath[project] = { ms: 0, sessions: 0 };
      byPath[project].sessions += 1;
      byPath[project].ms += Object.values(activeMsByDay(timestamps))
        .reduce((sum, ms) => sum + ms, 0);
    }

    const home = os.homedir();
    const rows = Object.entries(byPath).map(([projectPath, v]) => ({
      path: projectPath,
      displayPath: projectPath.startsWith(home) ? `~${projectPath.slice(home.length)}` : projectPath,
      category: classifyProject(projectPath, config),
      hours: parseFloat((v.ms / 3_600_000).toFixed(2)),
      sessions: v.sessions,
    }));

    rows.sort((a, b) => b.hours - a.hours || a.path.localeCompare(b.path));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Verify the read endpoints**

Run in one terminal: `cd backend && npm run dev`
Run in another:

```bash
curl -s localhost:8089/api/config | head -c 400
curl -s localhost:8089/api/projects | head -c 400
```

Expected: `/api/config` returns `"source":"defaults"` and `"unconfigured":true` (assuming no config file exists yet). `/api/projects` returns an array whose first element has `path`, `displayPath` starting with `~`, `category: "uncategorized"`, and a numeric `hours`.

- [ ] **Step 4: Verify validation rejects bad input**

```bash
curl -s -X PUT localhost:8089/api/config -H 'Content-Type: application/json' \
  -d '{"version":1,"work":{"roots":["relative/path"],"contains":[]},"nonWork":{"roots":[],"contains":[]}}'
```

Expected: HTTP 400 with `{"errors":[{"path":"work.roots[0]","message":"Must start with ~ ..."}]}`
Confirm no config file was written: `test -f ~/.claude/session-jibble.config.json && echo WROTE || echo "correctly did not write"`

- [ ] **Step 5: Verify a successful save round-trips**

```bash
curl -s -X PUT localhost:8089/api/config -H 'Content-Type: application/json' \
  -d '{"version":1,"work":{"roots":["~/gitlab-projects","~/skyiq-master-codebase"],"contains":["skyiq"]},"nonWork":{"roots":["~/ai-research","~/test-project"],"contains":[]}}'
curl -s localhost:8089/api/config
curl -s localhost:8089/api/projects | grep -o '"category":"[a-zA-Z]*"' | sort | uniq -c
```

Expected: the PUT returns `"unconfigured":false`; the GET returns `"source":"file"`; the last command shows a mix of `work`, `nonWork` and `uncategorized` counts rather than all-uncategorized.

- [ ] **Step 6: Commit**

```bash
git add backend/server.js
git commit -m "feat(backend): add config and projects endpoints"
```

---

### Task 4: Category fields on the stats endpoints

**Files:**
- Modify: `backend/server.js` — `parseClaudeData()` and `parseDailyStats()`

**Interfaces:**
- Consumes: `classifyProject`, `loadConfig` (already imported in Task 3).
- Produces: `category` on every element of `GET /api/stats`; `workHours`, `nonWorkHours`, `uncategorizedHours` on every element of `GET /api/daily-stats`.

- [ ] **Step 1: Record the current daily-stats output so the change can be proven non-destructive**

```bash
curl -s localhost:8089/api/daily-stats > /tmp/daily-before.json
head -c 200 /tmp/daily-before.json
```

- [ ] **Step 2: Add `category` to each session**

In `backend/server.js`, inside `parseClaudeData()`, add this immediately **above** the existing first statement `const sessionGroups = groupSessionsFromHistory(readHistory());`:

```js
  const { config } = loadConfig();
```

Then in the `sessions.push({ ... })` object literal, immediately after the `project: projectName,` line, add:

```js
      category: classifyProject(project, config),
```

- [ ] **Step 3: Rewrite `parseDailyStats` to split by category**

Replace the whole body of `parseDailyStats()` with:

```js
function parseDailyStats() {
  const { config } = loadConfig();
  const sessionGroups = groupSessionsFromHistory(readHistory());
  const byDay = {};      // date -> total ms
  const byDayCat = {};   // date -> { work, nonWork, uncategorized } ms

  for (const { project, timestamps } of Object.values(sessionGroups)) {
    const category = classifyProject(project, config);

    // Attribute this session's gaps on their own map first, then fold into the
    // totals — so the same attributeGap call produces both the overall figure
    // and the per-category split, and they can never disagree.
    const sessionByDay = {};
    for (let i = 1; i < timestamps.length; i++) {
      attributeGap(sessionByDay, timestamps[i - 1], timestamps[i]);
    }

    for (const [date, ms] of Object.entries(sessionByDay)) {
      byDay[date] = (byDay[date] || 0) + ms;
      if (!byDayCat[date]) byDayCat[date] = { work: 0, nonWork: 0, uncategorized: 0 };
      byDayCat[date][category] += ms;
    }
  }

  return Object.entries(byDay).map(([date, ms]) => ({
    date,
    hours: parseFloat((ms / 3_600_000).toFixed(2)),
    // Each rounded independently, so these three can differ from `hours` by up
    // to 0.01h. The UI shows one at a time at 1dp, so it is never visible.
    workHours: parseFloat((byDayCat[date].work / 3_600_000).toFixed(2)),
    nonWorkHours: parseFloat((byDayCat[date].nonWork / 3_600_000).toFixed(2)),
    uncategorizedHours: parseFloat((byDayCat[date].uncategorized / 3_600_000).toFixed(2)),
  }));
}
```

- [ ] **Step 4: Prove `hours` did not change**

```bash
curl -s localhost:8089/api/daily-stats > /tmp/daily-after.json
node -e "
const a=require('/tmp/daily-before.json'), b=require('/tmp/daily-after.json');
const mb=Object.fromEntries(b.map(r=>[r.date,r]));
let bad=0;
for(const r of a){ if(!mb[r.date] || mb[r.date].hours!==r.hours){bad++;console.log('DRIFT',r.date,r.hours,mb[r.date]&&mb[r.date].hours);} }
console.log(bad===0?'PASS: every hours value identical across '+a.length+' days':'FAIL: '+bad+' days drifted');
"
```

Expected: `PASS: every hours value identical across N days`

- [ ] **Step 5: Verify the category fields sum correctly**

```bash
node -e "
const d=require('/tmp/daily-after.json');
let worst=0;
for(const r of d){
  const sum=r.workHours+r.nonWorkHours+r.uncategorizedHours;
  worst=Math.max(worst, Math.abs(sum-r.hours));
}
console.log('worst deviation from hours:', worst.toFixed(4)+'h', worst<=0.011?'PASS':'FAIL');
"
curl -s localhost:8089/api/stats | grep -o '\"category\":\"[a-zA-Z]*\"' | sort | uniq -c
```

Expected: worst deviation ≤ 0.011h and `PASS`; the second command shows a mix of categories.

- [ ] **Step 6: Commit**

```bash
git add backend/server.js
git commit -m "feat(backend): split daily stats by category and tag sessions"
```

---

### Task 5: Frontend types and the filter control

**Files:**
- Modify: `frontend/src/lib/types.ts`
- Create: `frontend/src/components/CategoryFilter.tsx`

**Interfaces:**
- Consumes: the API shapes produced by Tasks 3 and 4.
- Produces:
  - `type Category = 'work' | 'nonWork' | 'uncategorized'`
  - `type CategoryFilterValue = 'all' | Category`
  - `CATEGORY_LABELS: Record<Category, string>`
  - `<CategoryFilter value onChange uncategorizedCount />`

- [ ] **Step 1: Extend the types**

In `frontend/src/lib/types.ts`, add at the top of the file:

```ts
export type Category = 'work' | 'nonWork' | 'uncategorized';
export type CategoryFilterValue = 'all' | Category;

// User-facing labels. "Non-work" deliberately, never "Personal" — the folder
// path cannot know why the time was spent.
export const CATEGORY_LABELS: Record<CategoryFilterValue, string> = {
  all: 'All',
  work: 'Work',
  nonWork: 'Non-work',
  uncategorized: 'Uncategorized',
};

export interface CategoryRules {
  roots: string[];
  contains: string[];
}

export interface CategoryConfig {
  version: number;
  work: CategoryRules;
  nonWork: CategoryRules;
}

// Shape returned by GET /api/config and PUT /api/config
export interface ConfigResponse {
  config: CategoryConfig;
  source: 'file' | 'defaults';
  error: string | null;
  unconfigured: boolean;
}

// Shape returned by GET /api/projects
export interface ProjectRow {
  path: string;
  displayPath: string;
  category: Category;
  hours: number;
  sessions: number;
}

export interface ConfigFieldError {
  path: string;
  message: string;
}
```

In the same file, add `category: Category;` to the `Session` interface immediately after the `project: string;` line, and replace the `DayStats` interface with:

```ts
// Shape returned by GET /api/daily-stats
export interface DayStats {
  date: string;
  hours: number;
  workHours: number;
  nonWorkHours: number;
  uncategorizedHours: number;
}
```

- [ ] **Step 2: Create the filter control**

Create `frontend/src/components/CategoryFilter.tsx`:

```tsx
import { cn } from '@/lib/utils';
import { CATEGORY_LABELS, type CategoryFilterValue } from '@/lib/types';

interface Props {
  value: CategoryFilterValue;
  onChange: (value: CategoryFilterValue) => void;
  uncategorizedCount: number;
}

const BASE_OPTIONS: CategoryFilterValue[] = ['all', 'work', 'nonWork'];

export function CategoryFilter({ value, onChange, uncategorizedCount }: Props) {
  // Uncategorized only appears when it has something in it, so a fully
  // configured team never sees a permanently empty tab.
  const options: CategoryFilterValue[] =
    uncategorizedCount > 0 ? [...BASE_OPTIONS, 'uncategorized'] : BASE_OPTIONS;

  const move = (direction: 1 | -1) => {
    const i = options.indexOf(value);
    const from = i === -1 ? 0 : i;
    onChange(options[(from + direction + options.length) % options.length]);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Filter by category"
      className="inline-flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5"
      onKeyDown={e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      }}
    >
      {options.map(option => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: one tab stop for the group, arrows move within it.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              // Active state carries weight as well as background, so it never
              // depends on colour alone.
              active
                ? 'bg-background font-semibold text-foreground shadow-sm'
                : 'font-normal text-muted-foreground hover:text-foreground'
            )}
          >
            {CATEGORY_LABELS[option]}
            {option === 'uncategorized' && (
              <span className="rounded-full bg-amber-100 px-1.5 text-xs font-medium text-amber-900">
                {uncategorizedCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: errors ONLY in files not yet updated (`App.tsx`, `TodayCards.tsx`, `SessionsTable.tsx` will complain that `Session.category` / `DayStats.workHours` are missing from mock data or unused). `CategoryFilter.tsx` and `types.ts` themselves must be clean. Task 7 clears the rest.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/components/CategoryFilter.tsx
git commit -m "feat(frontend): add category types and segmented filter control"
```

---

### Task 6: Sheet primitive and Settings panel

**Files:**
- Create: `frontend/src/components/ui/sheet.tsx`
- Create: `frontend/src/components/SettingsPanel.tsx`
- Modify: `frontend/package.json` (via `npm install`)

**Interfaces:**
- Consumes: `CategoryConfig`, `ConfigResponse`, `ProjectRow`, `ConfigFieldError` from `types.ts`.
- Produces: `<SettingsPanel open onOpenChange config projects onSaved />` where `onSaved: (config: CategoryConfig) => void`.

- [ ] **Step 1: Install the dependency**

```bash
cd frontend && npm install @radix-ui/react-dialog
```

- [ ] **Step 2: Create the sheet primitive**

Create `frontend/src/components/ui/sheet.tsx`. Note: no `animate-in`/`animate-out` classes — `tailwindcss-animate` is not installed in this project.

```tsx
import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & { side?: 'left' | 'right' }
>(({ className, children, side = 'right', ...props }, ref) => (
  <SheetPrimitive.Portal>
    <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-50 flex h-full w-full flex-col gap-4 overflow-y-auto bg-background p-6 shadow-lg sm:max-w-lg',
        side === 'right' ? 'inset-y-0 right-0 border-l' : 'inset-y-0 left-0 border-r',
        className
      )}
      {...props}
    >
      {children}
      <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <X className="h-4 w-4" />
        <span className="sr-only">Close settings</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPrimitive.Portal>
));
SheetContent.displayName = 'SheetContent';

// Radix warns if a Dialog has no Title, so both of these are required, not optional.
const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title ref={ref} className={cn('text-lg font-semibold', className)} {...props} />
));
SheetTitle.displayName = 'SheetTitle';

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
SheetDescription.displayName = 'SheetDescription';

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetTitle, SheetDescription };
```

- [ ] **Step 3: Create the settings panel**

Create `frontend/src/components/SettingsPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Plus, Trash2, Check, AlertCircle } from 'lucide-react';
import {
  Sheet, SheetContent, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type {
  CategoryConfig, ConfigFieldError, ProjectRow,
} from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: CategoryConfig;
  projects: ProjectRow[];
  onSaved: (config: CategoryConfig) => void;
}

type RuleCategory = 'work' | 'nonWork';
type RuleField = 'roots' | 'contains';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// Mirrors the backend's ABSOLUTE_RE so the user learns about a bad path on blur
// rather than after a failed round-trip.
const ABSOLUTE_RE = /^(\/|[a-zA-Z]:[\\/]|\\\\|~($|[\\/]))/;

const isValidRoot = (value: string) => ABSOLUTE_RE.test(value.trim());

const clone = (c: CategoryConfig): CategoryConfig => ({
  version: c.version,
  work: { roots: [...c.work.roots], contains: [...c.work.contains] },
  nonWork: { roots: [...c.nonWork.roots], contains: [...c.nonWork.contains] },
});

export function SettingsPanel({ open, onOpenChange, config, projects, onSaved }: Props) {
  const [draft, setDraft] = useState<CategoryConfig>(() => clone(config));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [serverErrors, setServerErrors] = useState<ConfigFieldError[]>([]);

  // Re-seed the draft each time the panel opens, so a cancelled edit is discarded.
  useEffect(() => {
    if (open) {
      setDraft(clone(config));
      setSaveState('idle');
      setServerErrors([]);
    }
  }, [open, config]);

  const addEntry = (category: RuleCategory, field: RuleField, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setDraft(prev => {
      if (prev[category][field].includes(trimmed)) return prev;
      const next = clone(prev);
      next[category][field].push(trimmed);
      return next;
    });
    setSaveState('idle');
  };

  const removeEntry = (category: RuleCategory, field: RuleField, index: number) => {
    setDraft(prev => {
      const next = clone(prev);
      next[category][field].splice(index, 1);
      return next;
    });
    setSaveState('idle');
  };

  const save = async () => {
    setSaveState('saving');
    setServerErrors([]);
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (res.status === 400) {
        const body = await res.json();
        setServerErrors(body.errors ?? []);
        setSaveState('error');
        return;
      }
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      const body = await res.json();
      setSaveState('saved');
      onSaved(body.config);
    } catch {
      setServerErrors([{ path: '', message: 'Could not reach the backend on :8089' }]);
      setSaveState('error');
    }
  };

  const uncategorized = projects.filter(p => p.category === 'uncategorized');

  // A name rule matching every known folder is nearly always a typo — most often a
  // fragment that also appears in the home directory, which would sweep everything
  // into one category. Warn rather than block; it is legal, just rarely intended.
  const overBroad =
    projects.length === 0
      ? []
      : (['work', 'nonWork'] as RuleCategory[]).flatMap(category =>
          draft[category].contains.filter(fragment => {
            const frag = fragment.trim().replace(/\\/g, '/').toLowerCase();
            return frag.length > 0 && projects.every(p => p.path.toLowerCase().includes(frag));
          })
        );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <div className="space-y-1.5">
          <SheetTitle>Category settings</SheetTitle>
          <SheetDescription>
            Folders you list here are classified as work or non-work. The most specific
            folder wins, so a personal repo inside a work folder can be listed separately.
          </SheetDescription>
        </div>

        <RuleSection
          title="Work folders"
          category="work"
          draft={draft}
          onAdd={addEntry}
          onRemove={removeEntry}
        />
        <RuleSection
          title="Non-work folders"
          category="nonWork"
          draft={draft}
          onAdd={addEntry}
          onRemove={removeEntry}
        />

        {uncategorized.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              Uncategorized ({uncategorized.length})
            </h3>
            <p className="text-xs text-muted-foreground">
              No rule matches these folders yet. Assign the ones that matter — the rest
              stay uncategorized.
            </p>
            <ul className="space-y-1">
              {uncategorized.slice(0, 25).map(p => (
                <li key={p.path} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate" title={p.path}>{p.displayPath}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {p.hours.toFixed(1)}h
                  </span>
                  <Button variant="outline" size="sm"
                    onClick={() => addEntry('work', 'roots', p.displayPath)}>
                    → Work
                  </Button>
                  <Button variant="outline" size="sm"
                    onClick={() => addEntry('nonWork', 'roots', p.displayPath)}>
                    → Non-work
                  </Button>
                </li>
              ))}
            </ul>
            {uncategorized.length > 25 && (
              <p className="text-xs text-muted-foreground">
                Showing the 25 with the most hours, of {uncategorized.length}.
              </p>
            )}
          </section>
        )}

        {overBroad.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="h-4 w-4" />
              Very broad name rule
            </div>
            <p className="mt-1">
              {overBroad.map(f => `"${f}"`).join(', ')} matches every folder in your
              history, so everything will land in one category. Check for a fragment
              that also appears in your home directory path.
            </p>
          </div>
        )}

        {serverErrors.length > 0 && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="h-4 w-4" />
              Could not save
            </div>
            <ul className="mt-1 list-disc pl-5">
              {serverErrors.map((e, i) => (
                <li key={i}>{e.path ? `${e.path}: ` : ''}{e.message}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-auto flex items-center gap-3 border-t pt-4">
          <Button onClick={save} disabled={saveState === 'saving'}>
            {saveState === 'saving' ? 'Saving…' : 'Save'}
          </Button>
          {saveState === 'saved' && (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Check className="h-4 w-4" /> Saved
            </span>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface RuleSectionProps {
  title: string;
  category: RuleCategory;
  draft: CategoryConfig;
  onAdd: (category: RuleCategory, field: RuleField, value: string) => void;
  onRemove: (category: RuleCategory, field: RuleField, index: number) => void;
}

function RuleSection({ title, category, draft, onAdd, onRemove }: RuleSectionProps) {
  const [rootDraft, setRootDraft] = useState('');
  const [rootError, setRootError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const rootInputId = `${category}-root`;
  const nameInputId = `${category}-name`;

  const commitRoot = () => {
    const value = rootDraft.trim();
    if (!value) { setRootError(null); return; }
    if (!isValidRoot(value)) {
      setRootError('Must start with ~ or be an absolute path');
      return;
    }
    setRootError(null);
    onAdd(category, 'roots', value);
    setRootDraft('');
  };

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>

      <ul className="space-y-1">
        {draft[category].roots.map((root, i) => (
          <li key={`${root}-${i}`} className="flex items-center gap-2 text-sm">
            <span className="flex-1 truncate font-mono text-xs" title={root}>{root}</span>
            <Button variant="ghost" size="sm" onClick={() => onRemove(category, 'roots', i)}
              aria-label={`Remove ${root}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </li>
        ))}
      </ul>

      <div className="space-y-1">
        <label htmlFor={rootInputId} className="text-xs text-muted-foreground">
          Add a folder
        </label>
        <div className="flex gap-2">
          <input
            id={rootInputId}
            value={rootDraft}
            placeholder="~/gitlab-projects"
            onChange={e => { setRootDraft(e.target.value); setRootError(null); }}
            // Validate on blur, not on submit — the user learns immediately.
            onBlur={commitRoot}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitRoot(); } }}
            className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button variant="outline" size="sm" onClick={commitRoot} aria-label={`Add folder to ${title}`}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {rootError && (
          <p className="flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" />
            {rootError}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor={nameInputId} className="text-xs text-muted-foreground">
          Also match any path containing
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          {draft[category].contains.map((fragment, i) => (
            <span key={`${fragment}-${i}`}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs">
              {fragment}
              <button type="button" onClick={() => onRemove(category, 'contains', i)}
                aria-label={`Remove ${fragment}`}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <input
          id={nameInputId}
          value={nameDraft}
          placeholder="skyiq"
          onChange={e => setNameDraft(e.target.value)}
          onBlur={() => { onAdd(category, 'contains', nameDraft); setNameDraft(''); }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd(category, 'contains', nameDraft);
              setNameDraft('');
            }
          }}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: `sheet.tsx` and `SettingsPanel.tsx` clean. Remaining errors only in `App.tsx` / `TodayCards.tsx` / `SessionsTable.tsx`, cleared by Task 7.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/ui/sheet.tsx frontend/src/components/SettingsPanel.tsx
git commit -m "feat(frontend): add sheet primitive and category settings panel"
```

---

### Task 7: Thread the filter through the dashboard

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/HoursChart.tsx`
- Modify: `frontend/src/components/TodayCards.tsx`
- Modify: `frontend/src/components/SessionsTable.tsx`
- Modify: `frontend/src/lib/exportJson.ts`

**Interfaces:**
- Consumes: `CategoryFilter` (Task 5), `SettingsPanel` (Task 6), all types from Task 5, both API changes from Tasks 3–4.
- Produces: the finished feature. Nothing downstream.

- [ ] **Step 1: Add the category prop to `HoursChart`**

In `frontend/src/components/HoursChart.tsx`:

Replace the type import with these two lines — `CATEGORY_LABELS` is a value, not a type, so it needs its own non-`type` import:

```tsx
import { CATEGORY_LABELS } from '@/lib/types';
import type { DayStats, CategoryFilterValue } from '@/lib/types';
```

Then replace the `BAR_FILL` constant with:

```tsx
// All and Work keep the existing near-black primary; the other two are distinct
// hues, each at least 4.5:1 against the card background.
const BAR_FILL = 'hsl(222.2 47.4% 11.2%)';
const FILL_BY_CATEGORY: Record<CategoryFilterValue, string> = {
  all: BAR_FILL,
  work: BAR_FILL,
  nonWork: 'hsl(262 60% 48%)',
  uncategorized: 'hsl(215 20% 45%)',
};
const FIELD_BY_CATEGORY: Record<CategoryFilterValue, keyof DayStats> = {
  all: 'hours',
  work: 'workHours',
  nonWork: 'nonWorkHours',
  uncategorized: 'uncategorizedHours',
};
```

Add `category: CategoryFilterValue;` to the `Props` interface, and destructure it in the signature:

```tsx
export function HoursChart({ dailyStats, selectedDates, onSelectDates, category }: Props) {
```

Inside the `data` useMemo, replace the two lines that build `byDate` and push the day so they read the category's field:

```tsx
    const field = FIELD_BY_CATEGORY[category];
    const byDate: Record<string, number> = {};
    for (const r of dailyStats) byDate[r.date] = (r[field] as number) ?? 0;
```

and add `category` to that useMemo's dependency array: `}, [dailyStats, category]);`

Replace the `<CardTitle>` and both `fill={BAR_FILL}` usages:

```tsx
        <CardTitle>
          Hours per Day{category !== 'all' ? ` · ${CATEGORY_LABELS[category]}` : ''}
        </CardTitle>
```

Then in `ReferenceArea` use `fill={FILL_BY_CATEGORY[category]}`, and in `<Cell>` use `fill={FILL_BY_CATEGORY[category]}` in place of `fill={BAR_FILL}`.

- [ ] **Step 2: Add the category prop to `TodayCards`**

In `frontend/src/components/TodayCards.tsx`, change the import and `Props`:

```tsx
import type { Session, DayStats, CategoryFilterValue } from '@/lib/types';

interface Props {
  sessions: Session[];
  dailyStats: DayStats[];
  category: CategoryFilterValue;
}
```

Replace the function signature and the first four statements of the body:

```tsx
export function TodayCards({ sessions, dailyStats, category }: Props) {
  const today = localDateStr();

  // Category filter applies before the today filter, so every card reflects the
  // same slice the chart and table are showing.
  const scoped = category === 'all' ? sessions : sessions.filter(s => s.category === category);
  const todaySessions = scoped.filter(s => s.activeDates?.includes(today));

  const todayRow = dailyStats.find(d => d.date === today);
  const todayHours =
    category === 'all' ? todayRow?.hours ?? 0
    : category === 'work' ? todayRow?.workHours ?? 0
    : category === 'nonWork' ? todayRow?.nonWorkHours ?? 0
    : todayRow?.uncategorizedHours ?? 0;
```

- [ ] **Step 3: Add the category prop to `SessionsTable`**

In `frontend/src/components/SessionsTable.tsx`, add to the type import:

```tsx
import type { Session, SessionDay, CategoryFilterValue } from '@/lib/types';
```

Add `category: CategoryFilterValue;` to `Props`, destructure it, and insert this immediately after the `const isFiltered = ...` line:

```tsx
  // Category narrows the pool first; the date filter then applies to what remains,
  // so the two compose rather than fighting.
  const scoped = useMemo(
    () => (category === 'all' ? sessions : sessions.filter(s => s.category === category)),
    [sessions, category]
  );
```

Then replace every remaining use of `sessions` **inside the two useMemos and the unfiltered branch** with `scoped`:
- in the `sessionDays` useMemo: `for (const session of scoped)` and dependency `[scoped, selectedDates, isFiltered]`
- in the `displayRows` useMemo: `return scoped.map(s => ({` and dependency `[isFiltered, sessionDays, scoped]`
- in `description`: `` `${scoped.length} sessions total · sorted by most recent activity` ``

Finally, extend the page-reset guard so a category change also resets pagination:

```tsx
  const selectionKey = `${category}|${selectedDates.join(',')}`;
```

- [ ] **Step 4: Stamp the category into exports**

In `frontend/src/lib/exportJson.ts`, add to the import and the payload type:

```ts
import type { SessionDay, CategoryFilterValue } from './types';
```

Add `category: CategoryFilterValue;` to `ExportPayload` immediately after `exportedAt`, change the signature to

```ts
export function buildExportPayload(
  selectedDates: string[],
  rows: SessionDay[],
  category: CategoryFilterValue
): ExportPayload {
```

and add `category,` to the returned object immediately after `exportedAt: localIsoString(),`.

In `SessionsTable.tsx`, update the call: `buildExportPayload(selectedDates, sessionDays, category)`.

- [ ] **Step 5: Wire it all up in `App.tsx`**

In `frontend/src/App.tsx`:

Extend the imports:

```tsx
import { RefreshCw, Settings } from 'lucide-react';
import { CategoryFilter } from '@/components/CategoryFilter';
import { SettingsPanel } from '@/components/SettingsPanel';
import type {
  Session, DayStats, CategoryFilterValue, CategoryConfig, ConfigResponse, ProjectRow,
} from '@/lib/types';
```

Add this above the component:

```tsx
const VALID_CATEGORIES: CategoryFilterValue[] = ['all', 'work', 'nonWork', 'uncategorized'];

// An unrecognised token falls back to 'all' rather than erroring.
function categoryFromUrl(): CategoryFilterValue {
  const raw = new URLSearchParams(window.location.search).get('category');
  return VALID_CATEGORIES.includes(raw as CategoryFilterValue)
    ? (raw as CategoryFilterValue)
    : 'all';
}
```

Add state alongside the existing hooks:

```tsx
  const [category, setCategory] = useState<CategoryFilterValue>(categoryFromUrl);
  const [config, setConfig] = useState<CategoryConfig | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
```

Inside `fetchData`, extend the two `Promise.all` calls to four requests:

```tsx
      const [statsRes, dailyRes, configRes, projectsRes] = await Promise.all([
        fetch('/api/stats'),
        fetch('/api/daily-stats'),
        fetch('/api/config'),
        fetch('/api/projects'),
      ]);
      if (!statsRes.ok) throw new Error(`API error: ${statsRes.status}`);
      if (!dailyRes.ok) throw new Error(`API error: ${dailyRes.status}`);
      const [statsData, dailyData, configData, projectData] = await Promise.all([
        statsRes.json(), dailyRes.json(), configRes.json(), projectsRes.json(),
      ]);
      setSessions(statsData);
      setDailyStats(dailyData);
      setConfig((configData as ConfigResponse).config);
      setUnconfigured((configData as ConfigResponse).unconfigured);
      setConfigError((configData as ConfigResponse).error);
      setProjects(projectData as ProjectRow[]);
```

Add this effect below the existing one:

```tsx
  // Mirror the filter into the URL so a filtered view can be shared or reloaded.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (category === 'all') url.searchParams.delete('category');
    else url.searchParams.set('category', category);
    window.history.replaceState({}, '', url);
  }, [category]);
```

Add above the `return`:

```tsx
  const uncategorizedCount = projects.filter(p => p.category === 'uncategorized').length;

  const handleConfigSaved = (saved: CategoryConfig) => {
    setConfig(saved);
    setUnconfigured(false);
    fetchData();
  };
```

In the header, replace the contents of the `ml-auto` div with:

```tsx
          <div className="ml-auto flex items-center gap-3">
            {!unconfigured && (
              <CategoryFilter
                value={category}
                onChange={setCategory}
                uncategorizedCount={uncategorizedCount}
              />
            )}
            <span className="text-sm text-muted-foreground">{today}</span>
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4 mr-1" />
              Settings
            </Button>
            <Button variant="outline" size="sm" onClick={fetchData} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
```

Directly below the existing `{error && (...)}` block, add:

```tsx
        {configError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {configError}
          </div>
        )}

        {unconfigured && !loading && (
          <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-4 py-3 text-sm">
            <span className="flex-1">
              No categories set up yet — tell the dashboard which folders are work
              and which aren't.
            </span>
            <Button size="sm" onClick={() => setSettingsOpen(true)}>Set up categories</Button>
          </div>
        )}
```

Pass `category` to the three consumers:

```tsx
        {!loading && <TodayCards sessions={sessions} dailyStats={dailyStats} category={category} />}
        {!loading && (
          <HoursChart
            dailyStats={dailyStats}
            selectedDates={selectedDates}
            onSelectDates={setSelectedDates}
            category={category}
          />
        )}
        {!loading && sessions.length > 0 && (
          <SessionsTable
            sessions={sessions}
            selectedDates={selectedDates}
            category={category}
            onClearFilter={() => setSelectedDates([])}
            onStatusChange={handleStatusChange}
          />
        )}
```

And render the panel just before the closing `</div>` of the outer wrapper:

```tsx
        {config && (
          <SettingsPanel
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            config={config}
            projects={projects}
            onSaved={handleConfigSaved}
          />
        )}
```

- [ ] **Step 6: Typecheck and lint**

Run: `cd frontend && npx tsc -b && npx eslint .`
Expected: both clean, zero errors.

- [ ] **Step 7: Verify in the browser**

Run `npm run dev` from the repo root, open `http://localhost:8088`, and confirm each of these:

1. With no config file (`rm -f ~/.claude/session-jibble.config.json` first, then refresh): the filter control is **hidden** and the "Set up categories" prompt shows.
2. Open Settings, add `~/gitlab-projects` under Work and `~/ai-research` under Non-work, Save. The button shows "Saving…" then a "Saved" check.
3. The prompt disappears and the filter appears. Selecting **Work** changes the chart title to "Hours per Day · Work", changes the bar values, updates Hours Today, and shrinks the session table.
4. Selecting **Non-work** turns the bars violet.
5. Typing `projects/thing` (a relative path) into a folder input and tabbing away shows "Must start with ~ or be an absolute path" and does not add it.
6. Drag a range on the chart while **Work** is selected — the table shows work sessions within that range only. Export JSON and confirm the file contains `"category": "work"`.
7. Press Tab to the filter and use arrow keys — focus ring is visible and selection moves.
8. `?category=nonWork` in the URL survives a page reload; `?category=bogus` falls back to All.

- [ ] **Step 8: Run the backend tests once more**

Run: `cd backend && npm test`
Expected: PASS, 27 tests.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/HoursChart.tsx frontend/src/components/TodayCards.tsx frontend/src/components/SessionsTable.tsx frontend/src/lib/exportJson.ts
git commit -m "feat(frontend): filter dashboard by work/non-work category"
```

---

### Task 8: Update project documentation

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing.

- [ ] **Step 1: Update the API table**

In `CLAUDE.md`, add these rows to the Backend API table:

```markdown
| GET | `/api/config` | Category rules, with `source` and any load error |
| PUT | `/api/config` | Validate and atomically save category rules |
| GET | `/api/projects` | Distinct project folders with resolved category and all-time hours |
```

- [ ] **Step 2: Update the data sources table**

Add this row:

```markdown
| `session-jibble.config.json` | Per-user work/non-work folder rules written by this app (not a Claude file) |
```

- [ ] **Step 3: Add a design-decisions entry**

Under "Key design decisions", add:

```markdown
### Category classification
Project folders resolve to `work`, `nonWork`, or `uncategorized` via
`backend/lib/categorize.js`. The most specific folder wins (longest matching path
prefix), and path rules always outrank name-substring rules. Comparison is
case-insensitive on Windows and macOS and case-sensitive on Linux, matching each
platform's filesystem. Platform behaviour is injected, never read from
`process.platform` inside the resolver, so both branches are testable from one machine.

Unmatched folders become `uncategorized` rather than silently counting as non-work —
a missing rule should be visible, not quietly under-report work hours.
```

- [ ] **Step 4: Note the test command**

Under "Running", add:

```markdown
```bash
# Backend unit tests (resolver + config validation)
npm test --prefix backend
```
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe category filter, config file and backend tests"
```

---

## Notes for the executor

- **Backend must be restarted** after Tasks 3 and 4 (`node server.js` has no watcher).
- **Task 4 Step 1 must run before Task 4 Step 2**, or there is no baseline to prove `hours` did not drift.
- Tasks 5 and 6 leave `tsc` failing on files they do not touch. That is expected; Task 7 clears it. Do not "fix" those errors early by editing App/TodayCards/SessionsTable ahead of Task 7.
- The spec says "Save is disabled while any field holds a blocking error." In this
  implementation that condition is satisfied structurally rather than with a guard: an
  invalid root is rejected at the input's `onBlur` and never enters `draft`, so the
  draft cannot hold a blocking error by the time Save is reachable. Do not add a
  disabled-state check for a state that cannot occur — if you change the input flow so
  invalid values *can* enter the draft, add the guard then.
- Task 1 and Task 2 are the only tasks with real red-green-refactor cycles. Tasks 3–8 verify through curl, `tsc`, `eslint` and the browser, because the repo has no HTTP or component test harness and adding one is out of scope for this plan.
