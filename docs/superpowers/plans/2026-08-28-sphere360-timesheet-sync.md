# Sphere360 Timesheet Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draft session-jibble's measured coding hours into Sphere360's week-scoped timesheet API, with a human confirming every write.

**Architecture:** Five small backend modules under `backend/lib/sphere360/` — two of them pure (`draft.js`, `merge.js`) because that is where a bug would silently corrupt a system of record. Two Express routes read a week and write a merged week. One React sheet renders filed rows, editable drafted rows, and per-day totals against an 8h floor.

**Tech Stack:** Node 22 (built-in test runner, built-in `process.loadEnvFile`), Express 5, React 19 + TypeScript, Radix Sheet, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-28-sphere360-timesheet-sync-design.md`

## Global Constraints

- **No new backend dependencies.** Node 22 ships `process.loadEnvFile` and global `fetch`; deps stay `express` + `cors`.
- **Tests use the Node built-in runner.** `node --test test/*.test.js`, files named `backend/test/*.test.js`, `require('node:test')` + `require('node:assert')`.
- **`toISOString()` is banned everywhere except `backend/lib/sphere360/week.js`.** CLAUDE.md's standing rule. `week.js` breaks it deliberately for `weekStart` only, with a comment saying why. `workDate` is always a local `YYYY-MM-DD`.
- **Frontend type-check is `npx tsc -b` from `frontend/`**, never `tsc --noEmit` — `tsconfig.json` is a solution config that type-checks zero files and always exits 0.
- **ESLint baseline is exactly 1 error** (`react-hooks/set-state-in-effect` in `App.tsx`). A change is clean when the count stays at 1, not 0.
- **8h is a floor, not a ceiling.** Over-logging is unremarkable; only a short day is flagged, and a short day never blocks confirm.
- **Drafted hours are uncorrected.** Every UI surface showing them carries the ⚠ uncorrected badge until `docs/billing-accuracy-plan.md` lands.
- **Never auto-submit.** No cron, no hook, no retry-on-write. Every POST is operator-initiated.

## File Structure

| File | Responsibility |
|---|---|
| `backend/lib/sphere360/week.js` | Local date ↔ Monday `weekStart` UTC instant. The only sanctioned `toISOString()`. |
| `backend/lib/sphere360/mapping.js` | Load / validate / save folder→project prefills; resolve a path to its mapping. |
| `backend/lib/sphere360/draft.js` | Pure. Collapse week activity into entries keyed by `(projectId, activityId, workDate)`. |
| `backend/lib/sphere360/merge.js` | Pure. Union drafted rows onto filed rows without dropping what it did not author. |
| `backend/lib/sphere360/client.js` | Only network module. `fetchWeek`, `upsertWeek`. Reads env at call time. |
| `backend/lib/categorize.js` | **Modify** — export `matchesRoot` so the mapping resolver reuses the segment-aware matcher. |
| `backend/server.js` | **Modify** — add 4 routes; expose full project paths to the draft builder. |
| `frontend/src/lib/types.ts` | **Modify** — add Sphere360 response types. |
| `frontend/src/components/TimesheetWeek.tsx` | Week sheet: filed rows, editable drafted rows, day totals, confirm. |
| `frontend/src/App.tsx` | **Modify** — mount the sheet behind a toolbar button. |

---

### Task 1: Confirm API assumptions with a read-only probe

The spec designs against four assumptions. This task replaces each with an observed fact before a single line of client code is written. **Nothing is POSTed.**

**Files:**
- Create: `backend/.env` (operator-supplied, gitignored — never committed)
- Modify: `docs/superpowers/specs/2026-08-28-sphere360-timesheet-sync-design.md` (append a findings block)

**Interfaces:**
- Consumes: nothing
- Produces: confirmed values for `upsert` semantics, entry `id` presence, taxonomy endpoint, and token TTL. Tasks 5 and 6 read these.

- [ ] **Step 1: Ask the operator to create `backend/.env`**

It must contain, with no quotes and no trailing spaces:

```
SPHERE360_TOKEN=<bearer token copied from the timesheet page's network tab>
```

Do not paste the token into any chat, commit, log line, or error message. `.gitignore:19` already ignores `.env` and `.env.*`.

- [ ] **Step 2: Decode the token's expiry locally**

```bash
cd backend && node -e '
process.loadEnvFile(".env");
const t = process.env.SPHERE360_TOKEN || "";
const parts = t.split(".");
if (parts.length !== 3) { console.log("not a JWT — treat TTL as unknown"); process.exit(0); }
const body = JSON.parse(Buffer.from(parts[1], "base64url").toString());
const exp = body.exp ? new Date(body.exp * 1000) : null;
console.log("exp:", exp ? exp.toString() : "none");
console.log("ttl_minutes:", exp ? Math.round((exp - Date.now()) / 60000) : "n/a");
'
```

Record `ttl_minutes`. It does not change the design — the posture is draft-and-confirm regardless — but it tells the operator how often they will re-paste.

- [ ] **Step 3: Read one week, read-only**

```bash
cd backend && node -e '
process.loadEnvFile(".env");
const r = await fetch("https://sphere360.airasia.com/api/timesheets?weekStart=2026-08-24T00:00:00.000Z", {
  headers: { authorization: `Bearer ${process.env.SPHERE360_TOKEN}` },
});
console.log("status:", r.status);
const text = await r.text();
console.log(text.slice(0, 2000));
' 2>&1 | head -40
```

If that path 404s, open the timesheet page in the browser, read the network tab, and record the actual GET path. Then re-run with it.

- [ ] **Step 4: Record the four findings in the spec**

Append to the spec's "Open questions" section, replacing each assumption with what was observed:

```markdown
## Probe findings — 2026-08-28

| Question | Observed | Effect on design |
|---|---|---|
| GET path for a week | `<observed path>` | `client.fetchWeek` uses it |
| Do entries carry a stable `id`? | `<yes/no>` | If yes, Task 5 rule 2 switches to id-based ownership |
| Taxonomy endpoint | `<observed path or "none found">` | If none, mapping file holds a hand-maintained list |
| Token TTL | `<n>` minutes | Operator re-pastes at this cadence |
| Does upsert replace the week? | `<observed / still unconfirmed>` | If it merges server-side, Task 5's rules stay correct but become redundant |
```

If the upsert question cannot be answered read-only, **leave the assumption as "replaces"**. Never test it by writing.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-28-sphere360-timesheet-sync-design.md
git commit -m "docs: record Sphere360 API probe findings"
```

---

### Task 2: `week.js` — the one sanctioned toISOString

**Files:**
- Create: `backend/lib/sphere360/week.js`
- Test: `backend/test/sphere360-week.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `mondayOf(localDate: string) -> string` — `'2026-08-26'` → `'2026-08-24'`
  - `weekStartInstant(localDate: string) -> string` — `'2026-08-26'` → `'2026-08-24T00:00:00.000Z'`
  - `weekDates(localDate: string) -> string[]` — the seven `YYYY-MM-DD` days, Monday first

- [ ] **Step 1: Write the failing test**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { mondayOf, weekStartInstant, weekDates } = require('../lib/sphere360/week');

test('mondayOf returns the same Monday for every day of that week', () => {
  for (const d of ['2026-08-24', '2026-08-26', '2026-08-30']) {
    assert.equal(mondayOf(d), '2026-08-24');
  }
});

test('mondayOf treats Sunday as the end of the week, not the start', () => {
  assert.equal(mondayOf('2026-08-30'), '2026-08-24');
  assert.equal(mondayOf('2026-08-31'), '2026-08-31');
});

test('weekStartInstant is UTC midnight of the Monday, regardless of local zone', () => {
  assert.equal(weekStartInstant('2026-08-26'), '2026-08-24T00:00:00.000Z');
});

test('weekStartInstant does not shift under UTC+8', () => {
  // The bug this guards: building the instant from a local Date would render
  // 2026-08-23T16:00:00.000Z in Kuala Lumpur. The Monday must not move.
  const prev = process.env.TZ;
  process.env.TZ = 'Asia/Kuala_Lumpur';
  try {
    assert.equal(weekStartInstant('2026-08-26'), '2026-08-24T00:00:00.000Z');
  } finally {
    process.env.TZ = prev;
  }
});

test('weekDates lists Monday through Sunday inclusive', () => {
  assert.deepEqual(weekDates('2026-08-26'), [
    '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
    '2026-08-28', '2026-08-29', '2026-08-30',
  ]);
});

test('weekDates crosses a year boundary without gaps', () => {
  assert.deepEqual(weekDates('2026-12-31'), [
    '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
    '2027-01-01', '2027-01-02', '2027-01-03',
  ]);
});

test('rejects a malformed date rather than guessing', () => {
  assert.throws(() => mondayOf('26-08-2026'), /YYYY-MM-DD/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/sphere360-week.test.js`
Expected: FAIL — `Cannot find module '../lib/sphere360/week'`

- [ ] **Step 3: Write the implementation**

```javascript
// The ONE module in this codebase allowed to call toISOString().
//
// CLAUDE.md bans it for date labels because it renders UTC and shifts the day
// for UTC+8. That rule still holds for `workDate`, which is a bare local date.
// But Sphere360's `weekStart` is genuinely a UTC-midnight *instant*, so it must
// be built from UTC parts and never from a local Date. Every date string in and
// out of this module is a local YYYY-MM-DD; only weekStartInstant returns an
// instant, and no other module may construct one.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertLocalDate(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d)) {
    throw new Error(`Expected a YYYY-MM-DD local date, got ${JSON.stringify(d)}`);
  }
}

// Parsed as UTC on purpose: these are calendar labels, not instants, so doing the
// arithmetic in UTC keeps it free of DST and offset effects entirely.
function toParts(localDate) {
  assertLocalDate(localDate);
  const [y, m, d] = localDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromParts(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function mondayOf(localDate) {
  const ms = toParts(localDate);
  const dow = new Date(ms).getUTCDay();       // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1;
  return fromParts(ms - backToMonday * 86_400_000);
}

function weekStartInstant(localDate) {
  return `${mondayOf(localDate)}T00:00:00.000Z`;
}

function weekDates(localDate) {
  const start = toParts(mondayOf(localDate));
  return Array.from({ length: 7 }, (_, i) => fromParts(start + i * 86_400_000));
}

module.exports = { mondayOf, weekStartInstant, weekDates };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/sphere360-week.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add backend/lib/sphere360/week.js backend/test/sphere360-week.test.js
git commit -m "feat(sphere360): add week boundary helpers with UTC-instant seam"
```

---

### Task 3: `mapping.js` — folder→project prefills

**Files:**
- Modify: `backend/lib/categorize.js:69` (the `module.exports` line — add `matchesRoot`)
- Create: `backend/lib/sphere360/mapping.js`
- Test: `backend/test/sphere360-mapping.test.js`

**Interfaces:**
- Consumes: `normalizePath`, `matchesRoot`, `DEFAULT_OPTIONS` from `../categorize`
- Produces:
  - `MAPPING_FILE: string`, `MAPPING_VERSION: 1`, `DEFAULT_MAPPING: object`
  - `validateMapping(raw) -> { mapping: object|null, errors: {path,message}[] }`
  - `loadMapping(file?) -> { mapping, source: 'file'|'defaults', error: string|null }`
  - `saveMapping(mapping, file?) -> void`
  - `resolveProject(projectPath, mapping, options?) -> { label, projectId, activityId } | null`

- [ ] **Step 1: Write the failing test**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_MAPPING, validateMapping, loadMapping, saveMapping, resolveProject,
} = require('../lib/sphere360/mapping');

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sj-ts-')), 'timesheet.json');

const valid = {
  version: 1,
  resourceId: '89f714e1-b2c2-4002-b197-577ef5399683',
  projects: [{
    label: 'SkyIQ / Development',
    roots: ['~/ai-research', '~/skyiq-reports'],
    projectId: '1804361',
    activityId: '5dbfdeb3-f41e-42c0-8410-d2d1725c1041',
  }],
  dailyMinimumHours: 8,
};

test('accepts a well-formed mapping', () => {
  const { mapping, errors } = validateMapping(valid);
  assert.deepEqual(errors, []);
  assert.equal(mapping.projects[0].projectId, '1804361');
  assert.equal(mapping.dailyMinimumHours, 8);
});

test('defaults dailyMinimumHours to 8 when absent', () => {
  const { mapping } = validateMapping({ ...valid, dailyMinimumHours: undefined });
  assert.equal(mapping.dailyMinimumHours, 8);
});

test('rejects a missing resourceId with a field path', () => {
  const { mapping, errors } = validateMapping({ ...valid, resourceId: '' });
  assert.equal(mapping, null);
  assert.equal(errors[0].path, 'resourceId');
});

test('rejects a relative root', () => {
  const { errors } = validateMapping({
    ...valid,
    projects: [{ ...valid.projects[0], roots: ['ai-research'] }],
  });
  assert.equal(errors[0].path, 'projects[0].roots[0]');
});

test('rejects a project missing its activityId', () => {
  const { errors } = validateMapping({
    ...valid,
    projects: [{ ...valid.projects[0], activityId: '' }],
  });
  assert.equal(errors[0].path, 'projects[0].activityId');
});

test('rejects the same root claimed by two projects', () => {
  // Ambiguous attribution is a mistake, and longest-prefix would silently pick one.
  const { errors } = validateMapping({
    ...valid,
    projects: [
      valid.projects[0],
      { label: 'Other', roots: ['~/ai-research'], projectId: '99', activityId: 'a' },
    ],
  });
  assert.match(errors[0].message, /also listed under/);
});

test('resolveProject picks the longest matching root', () => {
  const { mapping } = validateMapping({
    ...valid,
    projects: [
      { label: 'Broad', roots: ['/work'], projectId: '1', activityId: 'a' },
      { label: 'Narrow', roots: ['/work/skyiq'], projectId: '2', activityId: 'b' },
    ],
  });
  assert.equal(resolveProject('/work/skyiq/web', mapping).label, 'Narrow');
  assert.equal(resolveProject('/work/other', mapping).label, 'Broad');
});

test('resolveProject is segment-aware — /work/skyiqx is not inside /work/skyiq', () => {
  const { mapping } = validateMapping({
    ...valid,
    projects: [{ label: 'Narrow', roots: ['/work/skyiq'], projectId: '2', activityId: 'b' }],
  });
  assert.equal(resolveProject('/work/skyiqx', mapping), null);
});

test('resolveProject returns null for an unmapped path', () => {
  const { mapping } = validateMapping(valid);
  assert.equal(resolveProject('/somewhere/else', mapping), null);
});

test('loadMapping falls back to defaults with an error on a bad version', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ ...valid, version: 99 }));
  const { mapping, source, error } = loadMapping(file);
  assert.equal(source, 'defaults');
  assert.deepEqual(mapping, DEFAULT_MAPPING);
  assert.match(error, /version/);
});

test('saveMapping then loadMapping round-trips', () => {
  const file = tmpFile();
  const { mapping } = validateMapping(valid);
  saveMapping(mapping, file);
  assert.deepEqual(loadMapping(file).mapping, mapping);
});

test('drops unknown top-level keys on write', () => {
  const { mapping } = validateMapping({ ...valid, somethingElse: 1 });
  assert.equal(mapping.somethingElse, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/sphere360-mapping.test.js`
Expected: FAIL — `Cannot find module '../lib/sphere360/mapping'`

- [ ] **Step 3: Export `matchesRoot` from `categorize.js`**

The mapping resolver needs the same segment-aware matcher the category rules use — a second implementation would drift. Change the last line of `backend/lib/categorize.js` from:

```javascript
module.exports = { DEFAULT_OPTIONS, normalizePath, classifyProject };
```

to:

```javascript
module.exports = { DEFAULT_OPTIONS, normalizePath, matchesRoot, classifyProject };
```

- [ ] **Step 4: Write the implementation**

```javascript
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_OPTIONS, normalizePath, matchesRoot } = require('../categorize');

const MAPPING_FILE = path.join(os.homedir(), '.claude', 'session-jibble.timesheet.json');
const MAPPING_VERSION = 1;
const DEFAULT_MINIMUM_HOURS = 8;
const MAX_PROJECTS = 100;

// Empty on purpose, exactly as config.js is: seeding one person's projectIds
// would be wrong for everyone else, and a wrong projectId files real hours
// against the wrong client.
const DEFAULT_MAPPING = {
  version: MAPPING_VERSION,
  resourceId: '',
  projects: [],
  dailyMinimumHours: DEFAULT_MINIMUM_HOURS,
};

// Same shape config.js accepts, so a root learned there works here unchanged.
const ABSOLUTE_RE = /^(\/|[a-zA-Z]:[\\/]|\\\\|~($|[\\/]))/;

function validateMapping(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { mapping: null, errors: [{ path: '', message: 'Mapping must be an object' }] };
  }

  const errors = [];
  const out = {
    version: MAPPING_VERSION,
    resourceId: '',
    projects: [],
    dailyMinimumHours: DEFAULT_MINIMUM_HOURS,
  };

  if (typeof raw.resourceId !== 'string' || !raw.resourceId.trim()) {
    errors.push({ path: 'resourceId', message: 'Must be a non-empty string' });
  } else {
    out.resourceId = raw.resourceId.trim();
  }

  if (raw.dailyMinimumHours !== undefined) {
    const n = raw.dailyMinimumHours;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 24) {
      errors.push({ path: 'dailyMinimumHours', message: 'Must be a number between 0 and 24' });
    } else {
      out.dailyMinimumHours = n;
    }
  }

  const projects = raw.projects;
  if (!Array.isArray(projects)) {
    errors.push({ path: 'projects', message: '"projects" must be an array' });
    return { mapping: null, errors };
  }
  if (projects.length > MAX_PROJECTS) {
    errors.push({ path: 'projects', message: `At most ${MAX_PROJECTS} projects allowed` });
    return { mapping: null, errors };
  }

  // Root -> index of the project that claimed it. A repeat is always a mistake,
  // and longest-prefix would quietly resolve it to one of the two.
  const claimed = new Map();

  projects.forEach((p, i) => {
    const at = `projects[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      errors.push({ path: at, message: 'Must be an object' });
      return;
    }

    const entry = { label: '', roots: [], projectId: '', activityId: '' };

    for (const field of ['label', 'projectId', 'activityId']) {
      if (typeof p[field] !== 'string' || !p[field].trim()) {
        errors.push({ path: `${at}.${field}`, message: 'Must be a non-empty string' });
      } else {
        entry[field] = p[field].trim();
      }
    }

    if (!Array.isArray(p.roots) || p.roots.length === 0) {
      errors.push({ path: `${at}.roots`, message: 'Must be a non-empty array' });
    } else {
      p.roots.forEach((root, j) => {
        const rAt = `${at}.roots[${j}]`;
        if (typeof root !== 'string' || !root.trim()) {
          errors.push({ path: rAt, message: 'Must be a non-empty string' });
          return;
        }
        const value = root.trim();
        if (!ABSOLUTE_RE.test(value)) {
          errors.push({
            path: rAt,
            message: 'Must start with ~ or be absolute (/path, C:\\path, \\\\server\\share)',
          });
          return;
        }
        const key = normalizePath(value).toLowerCase();
        if (claimed.has(key) && claimed.get(key) !== i) {
          errors.push({
            path: rAt,
            message: `"${value}" is also listed under project ${claimed.get(key)} — a folder cannot belong to two projects`,
          });
          return;
        }
        if (claimed.get(key) === i) return;   // repeat within one project is noise
        claimed.set(key, i);
        entry.roots.push(value);
      });
    }

    out.projects.push(entry);
  });

  return { mapping: errors.length ? null : out, errors };
}

function loadMapping(file = MAPPING_FILE) {
  const fallback = (error) => ({ mapping: DEFAULT_MAPPING, source: 'defaults', error });

  if (!fs.existsSync(file)) return fallback(null);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback(`Could not parse ${file}: ${err.message}`);
  }

  if (raw?.version !== MAPPING_VERSION) {
    return fallback(
      `Unsupported mapping version ${JSON.stringify(raw?.version)} in ${file}; expected ${MAPPING_VERSION}`
    );
  }

  const { mapping, errors } = validateMapping(raw);
  if (!mapping) {
    return fallback(`Invalid mapping in ${file}: ${errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
  }
  return { mapping, source: 'file', error: null };
}

// Temp-then-rename, same reasoning as config.js: a concurrent reader sees the
// whole old file or the whole new one, never a truncated one.
function saveMapping(mapping, file = MAPPING_FILE) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2));
  fs.renameSync(tmp, file);
}

// Longest matching root wins, exactly as classifyProject ranks category roots.
// Returns null rather than a default: an unmapped folder must stay visible.
function resolveProject(projectPath, mapping, options) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (typeof projectPath !== 'string' || !projectPath.trim()) return null;
  const target = normalizePath(projectPath, opts);
  if (!target) return null;

  let best = null;
  for (const project of mapping?.projects ?? []) {
    for (const root of project.roots ?? []) {
      const r = normalizePath(root, opts);
      if (!matchesRoot(target, r, opts)) continue;
      if (best === null || r.length > best.length) {
        best = { length: r.length, project };
      }
    }
  }
  if (!best) return null;
  const { label, projectId, activityId } = best.project;
  return { label, projectId, activityId };
}

module.exports = {
  MAPPING_FILE, MAPPING_VERSION, DEFAULT_MAPPING,
  validateMapping, loadMapping, saveMapping, resolveProject,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && node --test test/sphere360-mapping.test.js && node --test test/categorize.test.js`
Expected: PASS both — the categorize suite confirms the added export broke nothing.

- [ ] **Step 6: Commit**

```bash
git add backend/lib/categorize.js backend/lib/sphere360/mapping.js backend/test/sphere360-mapping.test.js
git commit -m "feat(sphere360): add folder-to-project mapping with longest-prefix resolution"
```

---

### Task 4: `draft.js` — collapse week activity into entries

Pure. No I/O, no network, no clock.

**Files:**
- Create: `backend/lib/sphere360/draft.js`
- Test: `backend/test/sphere360-draft.test.js`

**Interfaces:**
- Consumes: `weekDates` from `./week`, `resolveProject` from `./mapping`
- Produces:
  - `buildDraft({ anyDateInWeek, sessions, mapping, hoursFor }) -> { entries, unmapped }`
    - `sessions: Array<{ projectPath: string, sessionId: string, excerpt: string, dates: string[] }>`
    - `hoursFor: (projectPath: string, date: string) => number`
    - `entries: Array<{ projectId, activityId, workDate, hours, comments }>`
    - `unmapped: Array<{ projectPath, hours }>`

> **Critical:** `sessions` carries the **set** of `(projectPath, date)` pairs and the excerpts. `hoursFor` is the **sole** authority on duration — `buildDraft` never reads an hours field off a session. That split is what lets the corrected billing-accuracy engine drop in later without touching this module.
>
> `projectPath` is the **full absolute path**, not `path.basename()`. The `/api/stats` session objects carry only the basename (`server.js:200`), so Task 6 supplies this shape from `groupSessionsFromHistory` instead.

- [ ] **Step 1: Write the failing test**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { buildDraft } = require('../lib/sphere360/draft');

const mapping = {
  version: 1,
  resourceId: 'r1',
  dailyMinimumHours: 8,
  projects: [
    { label: 'SkyIQ / Dev', roots: ['/work/skyiq'], projectId: '1804361', activityId: 'act-dev' },
    { label: 'SkyIQ / Scrum', roots: ['/work/scrum'], projectId: '1804361', activityId: 'act-scrum' },
  ],
};

const hours = (table) => (projectPath, date) => table[`${projectPath}|${date}`] ?? 0;

test('collapses two repos under one project+activity into a single entry', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'finishing FE tasks', dates: ['2026-08-26'] },
      { projectPath: '/work/skyiq/reports', sessionId: 's2', excerpt: 'aligning repos', dates: ['2026-08-26'] },
    ],
    mapping,
    hoursFor: hours({ '/work/skyiq/web|2026-08-26': 3.2, '/work/skyiq/reports|2026-08-26': 1.8 }),
  });

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    projectId: '1804361',
    activityId: 'act-dev',
    workDate: '2026-08-26',
    hours: 5,
    comments: 'web - finishing FE tasks\nreports - aligning repos',
  });
});

test('keeps different activityIds as separate entries on the same day', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'dev', dates: ['2026-08-26'] },
      { projectPath: '/work/scrum/notes', sessionId: 's2', excerpt: 'standup', dates: ['2026-08-26'] },
    ],
    mapping,
    hoursFor: hours({ '/work/skyiq/web|2026-08-26': 5, '/work/scrum/notes|2026-08-26': 1 }),
  });

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.activityId).sort(), ['act-dev', 'act-scrum']);
});

test('calls hoursFor once per (projectPath, date) even across multiple sessions', () => {
  // Two sessions in the same repo on the same day must not bill that day twice.
  const calls = [];
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'morning', dates: ['2026-08-26'] },
      { projectPath: '/work/skyiq/web', sessionId: 's2', excerpt: 'afternoon', dates: ['2026-08-26'] },
    ],
    mapping,
    hoursFor: (p, d) => { calls.push(`${p}|${d}`); return 4; },
  });

  assert.equal(calls.length, 1);
  assert.equal(entries[0].hours, 4);
  assert.equal(entries[0].comments, 'web - morning; afternoon');
});

test('excludes dates outside the requested week', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'in', dates: ['2026-08-26'] },
      { projectPath: '/work/skyiq/web', sessionId: 's2', excerpt: 'out', dates: ['2026-09-02'] },
    ],
    mapping,
    hoursFor: () => 2,
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].workDate, '2026-08-26');
});

test('reports unmapped folders instead of silently dropping them', () => {
  const { entries, unmapped } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/home/me/side-project', sessionId: 's1', excerpt: 'hobby', dates: ['2026-08-26', '2026-08-27'] },
    ],
    mapping,
    hoursFor: () => 0.2,
  });

  assert.deepEqual(entries, []);
  assert.deepEqual(unmapped, [{ projectPath: '/home/me/side-project', hours: 0.4 }]);
});

test('drops a group whose measured hours round to zero', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [{ projectPath: '/work/skyiq/web', sessionId: 's1', excerpt: 'blip', dates: ['2026-08-26'] }],
    mapping,
    hoursFor: () => 0,
  });
  assert.deepEqual(entries, []);
});

test('orders entries by date then project then activity, deterministically', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/scrum/n', sessionId: 's1', excerpt: 'b', dates: ['2026-08-27'] },
      { projectPath: '/work/skyiq/w', sessionId: 's2', excerpt: 'a', dates: ['2026-08-25'] },
      { projectPath: '/work/scrum/n', sessionId: 's3', excerpt: 'c', dates: ['2026-08-25'] },
    ],
    mapping,
    hoursFor: () => 1,
  });

  assert.deepEqual(
    entries.map(e => `${e.workDate}/${e.activityId}`),
    ['2026-08-25/act-dev', '2026-08-25/act-scrum', '2026-08-27/act-scrum']
  );
});

test('rounds summed hours to two decimals', () => {
  const { entries } = buildDraft({
    anyDateInWeek: '2026-08-26',
    sessions: [
      { projectPath: '/work/skyiq/a', sessionId: 's1', excerpt: 'x', dates: ['2026-08-26'] },
      { projectPath: '/work/skyiq/b', sessionId: 's2', excerpt: 'y', dates: ['2026-08-26'] },
    ],
    mapping,
    hoursFor: () => 0.335,
  });
  assert.equal(entries[0].hours, 0.67);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/sphere360-draft.test.js`
Expected: FAIL — `Cannot find module '../lib/sphere360/draft'`

- [ ] **Step 3: Write the implementation**

```javascript
const path = require('path');
const { weekDates } = require('./week');
const { resolveProject } = require('./mapping');

const round2 = (n) => parseFloat(n.toFixed(2));

// Pure. Given the week's activity and a mapping, produce the entries this app
// would file — collapsed the way a human files them: one row per
// (projectId, activityId, workDate), with each repo's work as its own comment line.
//
// `hoursFor` is the only source of duration. Sessions supply which
// (projectPath, date) pairs were active and what to say about them, never how long.
function buildDraft({ anyDateInWeek, sessions = [], mapping, hoursFor }) {
  const inWeek = new Set(weekDates(anyDateInWeek));

  // group key -> { projectId, activityId, workDate, paths: Map<projectPath, excerpts[]> }
  const groups = new Map();
  // projectPath -> Set<date>, so an unmapped folder is counted once per day
  const unmappedDays = new Map();

  for (const session of sessions) {
    const { projectPath, excerpt } = session;
    if (!projectPath) continue;

    for (const date of session.dates ?? []) {
      if (!inWeek.has(date)) continue;

      const project = resolveProject(projectPath, mapping);
      if (!project) {
        if (!unmappedDays.has(projectPath)) unmappedDays.set(projectPath, new Set());
        unmappedDays.get(projectPath).add(date);
        continue;
      }

      const key = `${project.projectId}|${project.activityId}|${date}`;
      if (!groups.has(key)) {
        groups.set(key, {
          projectId: project.projectId,
          activityId: project.activityId,
          workDate: date,
          paths: new Map(),
        });
      }
      const group = groups.get(key);
      if (!group.paths.has(projectPath)) group.paths.set(projectPath, []);
      const text = (excerpt || '').trim();
      if (text) group.paths.get(projectPath).push(text);
    }
  }

  const entries = [];
  for (const group of groups.values()) {
    // One hoursFor call per distinct (projectPath, date) — two sessions in the
    // same repo on the same day describe one block of time, not two.
    let hours = 0;
    const lines = [];
    for (const [projectPath, excerpts] of group.paths) {
      hours += hoursFor(projectPath, group.workDate) || 0;
      const name = path.basename(projectPath);
      lines.push(excerpts.length ? `${name} - ${excerpts.join('; ')}` : name);
    }

    hours = round2(hours);
    if (hours <= 0) continue;   // nothing measured is nothing to file

    entries.push({
      projectId: group.projectId,
      activityId: group.activityId,
      workDate: group.workDate,
      hours,
      comments: lines.join('\n'),
    });
  }

  entries.sort((a, b) =>
    a.workDate.localeCompare(b.workDate) ||
    a.projectId.localeCompare(b.projectId) ||
    a.activityId.localeCompare(b.activityId)
  );

  const unmapped = [...unmappedDays.entries()]
    .map(([projectPath, dates]) => ({
      projectPath,
      hours: round2([...dates].reduce((sum, d) => sum + (hoursFor(projectPath, d) || 0), 0)),
    }))
    .filter(u => u.hours > 0)
    .sort((a, b) => b.hours - a.hours || a.projectPath.localeCompare(b.projectPath));

  return { entries, unmapped };
}

module.exports = { buildDraft };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/sphere360-draft.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add backend/lib/sphere360/draft.js backend/test/sphere360-draft.test.js
git commit -m "feat(sphere360): collapse week activity into timesheet entries"
```

---

### Task 5: `merge.js` — never drop a row this app did not author

Pure, and the single most safety-critical module in the feature. The endpoint is assumed to **replace** the week, so any filed row missing from the posted array is destroyed.

**Files:**
- Create: `backend/lib/sphere360/merge.js`
- Test: `backend/test/sphere360-merge.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `entryKey(entry) -> string`
  - `mergeWeek({ filed, drafted }) -> { entries, replaced, kept }`

- [ ] **Step 1: Write the failing test**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeWeek, entryKey } = require('../lib/sphere360/merge');

const scrum = { projectId: '1804361', activityId: 'act-scrum', workDate: '2026-08-26', hours: 1, comments: 'Daily scrum' };
const social = { activityId: 'act-social', workDate: '2026-08-26', hours: 1, comments: 'ice creame party' };
const meeting = { projectId: '1804361', activityId: 'act-meet', workDate: '2026-08-26', hours: 0.67, comments: 'infra sync' };
const dev = { projectId: '1804361', activityId: 'act-dev', workDate: '2026-08-26', hours: 6.37, comments: 'web - FE tasks' };

test('a filed row this app did not author survives the union verbatim', () => {
  // THE most important test in this feature. If it ever fails, a week-replacing
  // POST deletes the operator's meetings.
  const { entries } = mergeWeek({ filed: [scrum, social, meeting], drafted: [dev] });

  assert.equal(entries.length, 4);
  for (const row of [scrum, social, meeting]) {
    assert.ok(entries.some(e => JSON.stringify(e) === JSON.stringify(row)),
      `filed row lost: ${row.comments}`);
  }
});

test('an entry with no projectId still keys and survives', () => {
  const { entries } = mergeWeek({ filed: [social], drafted: [] });
  assert.deepEqual(entries, [social]);
});

test('a drafted row replaces the filed row sharing its key', () => {
  const stale = { ...dev, hours: 5, comments: 'old text' };
  const { entries, replaced } = mergeWeek({ filed: [scrum, stale], drafted: [dev] });

  assert.equal(entries.length, 2);
  assert.equal(replaced.length, 1);
  assert.equal(entries.find(e => e.activityId === 'act-dev').hours, 6.37);
  assert.ok(entries.some(e => e.activityId === 'act-scrum'));
});

test('every filed row lands in exactly one of entries or replaced', () => {
  // The invariant that makes rule 1 checkable rather than merely intended.
  const stale = { ...dev, hours: 5 };
  const filed = [scrum, social, meeting, stale];
  const { entries, replaced } = mergeWeek({ filed, drafted: [dev] });

  for (const row of filed) {
    const inEntries = entries.some(e => JSON.stringify(e) === JSON.stringify(row));
    const inReplaced = replaced.some(e => JSON.stringify(e) === JSON.stringify(row));
    assert.ok(inEntries !== inReplaced, `row neither kept nor replaced: ${JSON.stringify(row)}`);
  }
});

test('an empty draft is a no-op that returns the week unchanged', () => {
  const { entries, replaced } = mergeWeek({ filed: [scrum, social], drafted: [] });
  assert.deepEqual(entries, [scrum, social]);
  assert.deepEqual(replaced, []);
});

test('rows on different dates never collide', () => {
  const tuesday = { ...dev, workDate: '2026-08-25' };
  const { entries, replaced } = mergeWeek({ filed: [tuesday], drafted: [dev] });
  assert.equal(entries.length, 2);
  assert.deepEqual(replaced, []);
});

test('entryKey distinguishes a missing projectId from an empty one', () => {
  assert.equal(entryKey(social), entryKey({ ...social, projectId: undefined }));
  assert.notEqual(entryKey(social), entryKey({ ...social, projectId: '1804361' }));
});

test('throws rather than posting a union that lost a row', () => {
  // Guards against a future refactor silently dropping filed rows.
  // TWO filed rows and zero replacements: the forced union holds only the single
  // drafted row, so 1 < 2 and the guard fires. With one filed row the threshold
  // would equal the union size and this test could never fail.
  assert.throws(
    () => mergeWeek({ filed: [scrum, social], drafted: [dev], __forceDrop: true }),
    /would drop/
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/sphere360-merge.test.js`
Expected: FAIL — `Cannot find module '../lib/sphere360/merge'`

- [ ] **Step 3: Write the implementation**

```javascript
// Pure. The safety core of the sync.
//
// `/api/timesheets/upsert` carries the whole week's entries, and is assumed to
// REPLACE that week. So anything filed but absent from the posted array is
// destroyed — including the meetings, scrums and leave this app cannot see and
// must never touch. Every rule here exists to make that impossible.

// Ownership key: the same triple draft.js groups by. A drafted row owns a filed
// row when both describe the same work on the same day. A missing projectId and
// an empty one are the same absence, so non-project rows key stably.
function entryKey(entry) {
  return [entry.workDate, entry.projectId ?? '', entry.activityId].join('|');
}

function mergeWeek({ filed = [], drafted = [], __forceDrop = false }) {
  const draftedKeys = new Set(drafted.map(entryKey));

  const kept = [];
  const replaced = [];
  for (const row of filed) {
    (draftedKeys.has(entryKey(row)) ? replaced : kept).push(row);
  }

  // __forceDrop exists only so the invariant below is provably live in tests.
  // Nothing in production sets it.
  const entries = __forceDrop ? [...drafted] : [...kept, ...drafted];

  // Rule 4: refuse to hand the network a union that lost a filed row. Cheap,
  // and it turns a whole class of refactor bug into a failed request instead of
  // a deleted timesheet.
  if (entries.length < filed.length - replaced.length) {
    throw new Error(
      `merge would drop ${filed.length - replaced.length - entries.length} filed row(s); refusing to post`
    );
  }

  return { entries, replaced, kept };
}

module.exports = { entryKey, mergeWeek };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/sphere360-merge.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add backend/lib/sphere360/merge.js backend/test/sphere360-merge.test.js
git commit -m "feat(sphere360): merge drafted rows without dropping filed work"
```

---

### Task 6: `client.js` — the only module that touches the network

**Files:**
- Create: `backend/lib/sphere360/client.js`
- Test: `backend/test/sphere360-client.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createClient({ fetchImpl?, baseUrl? }) -> { fetchWeek(weekStartInstant), upsertWeek({ weekStart, resourceId, entries }) }`
  - Thrown errors carry `.code`: `'NO_TOKEN'`, `'AUTH'`, `'HTTP'`

> Tests inject `fetchImpl`. **No test in this suite may reach the network.**
> Update the two paths below to whatever Task 1's probe observed.

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/sphere360-client.test.js`
Expected: FAIL — `Cannot find module '../lib/sphere360/client'`

- [ ] **Step 3: Write the implementation**

```javascript
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
      return Array.isArray(body) ? body : (body.entries ?? []);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/sphere360-client.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS — the six pre-existing suites plus the five new ones.

- [ ] **Step 6: Commit**

```bash
git add backend/lib/sphere360/client.js backend/test/sphere360-client.test.js
git commit -m "feat(sphere360): add API client with call-time token read"
```

---

### Task 7: Express routes

The repo has no server route tests — `backend/test/` covers `lib/` only. Follow that pattern: the logic these routes call is already covered by Tasks 2–6, and the routes themselves are verified by curl here.

**Files:**
- Modify: `backend/server.js` (imports near line 9; routes before `const PORT = 8089`)
- Test: verified by curl in Step 5 (no new test file, matching repo convention)

**Interfaces:**
- Consumes: everything from Tasks 2–6, plus existing `readHistory`, `groupSessionsFromHistory`, `activeMsByDay`, `toLocalDate` in `server.js`
- Produces:
  - `GET  /api/sphere360/mapping` → `{ mapping, source, error }`
  - `PUT  /api/sphere360/mapping` → `{ mapping }` or `400 { errors }`
  - `GET  /api/sphere360/week?date=YYYY-MM-DD` → the week payload below, including
    `projects[]` (the mapping's list, used by the UI's attribution dropdown)
  - `POST /api/sphere360/week` → `{ weekStart, written, replaced }`

- [ ] **Step 1: Load `.env` at startup**

Add immediately after the `require` block at the top of `backend/server.js`:

```javascript
// Node 22 ships this, so the Sphere360 token needs no dotenv dependency.
// Absent .env is normal — the sync routes report a missing token themselves.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env yet */ }
```

- [ ] **Step 2: Add the imports**

After the existing `require('./lib/config')` block:

```javascript
const { weekDates, mondayOf, weekStartInstant } = require('./lib/sphere360/week');
const {
  loadMapping, saveMapping, validateMapping,
} = require('./lib/sphere360/mapping');
const { buildDraft } = require('./lib/sphere360/draft');
const { mergeWeek, entryKey } = require('./lib/sphere360/merge');
const { createClient } = require('./lib/sphere360/client');
```

- [ ] **Step 3: Add the week-activity helper**

Place next to the other history helpers (after `activeMsByDay`, around line 195). This is the shape `buildDraft` needs, and it exists because `/api/stats` sessions carry only `path.basename(project)` — the mapping needs the **full** path.

```javascript
// Builds the (projectPath, date) activity for one week, with full paths.
// Hours are summed across concurrent sessions — the known uncorrected behaviour
// documented in docs/billing-accuracy-plan.md, surfaced in the UI as "uncorrected".
function weekActivity(dates) {
  const wanted = new Set(dates);
  const groups = groupSessionsFromHistory(readHistory());
  const sessions = [];
  const hoursTable = new Map();   // `${projectPath}|${date}` -> hours

  for (const [sessionId, { project, timestamps }] of Object.entries(groups)) {
    if (!project) continue;
    const byDay = activeMsByDay(timestamps);
    const active = Object.keys(byDay).filter(d => wanted.has(d));
    if (active.length === 0) continue;

    for (const date of active) {
      const key = `${project}|${date}`;
      hoursTable.set(key, (hoursTable.get(key) || 0) + byDay[date] / 3_600_000);
    }

    const projectDir = cwdToProjectDir(project);
    const aiTitle = projectDir ? getAiTitle(projectDir, sessionId) : '';
    sessions.push({
      projectPath: project,
      sessionId,
      excerpt: (aiTitle || '').slice(0, 100),
      dates: active,
    });
  }

  const hoursFor = (projectPath, date) =>
    parseFloat((hoursTable.get(`${projectPath}|${date}`) || 0).toFixed(2));

  return { sessions, hoursFor };
}
```

- [ ] **Step 4: Add the four routes**

Insert before `const PORT = 8089;`:

```javascript
app.get('/api/sphere360/mapping', (req, res) => {
  res.json(loadMapping());
});

app.put('/api/sphere360/mapping', (req, res) => {
  const { mapping, errors } = validateMapping(req.body);
  if (!mapping) return res.status(400).json({ errors });
  try {
    saveMapping(mapping);
    res.json({ mapping });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reads a week and returns it merged in preview: what is filed, what this app
// would draft, and what the day totals become. Nothing is written.
app.get('/api/sphere360/week', async (req, res) => {
  try {
    const anchor = req.query.date || toLocalDate(Date.now());
    const monday = mondayOf(anchor);
    const dates = weekDates(anchor);
    const { mapping, error: mappingError } = loadMapping();

    let filed = [];
    let fetchError = null;
    try {
      filed = await createClient().fetchWeek(weekStartInstant(anchor));
    } catch (err) {
      fetchError = { code: err.code, message: err.message };
    }

    const { sessions, hoursFor } = weekActivity(dates);
    const { entries: drafted, unmapped } =
      buildDraft({ anyDateInWeek: anchor, sessions, mapping, hoursFor });

    const { entries: preview, replaced } = mergeWeek({ filed, drafted });
    const replacedKeys = replaced.map(entryKey);

    const minimum = mapping.dailyMinimumHours;
    const byDay = dates.map((date, i) => {
      const on = (list) => list.filter(e => e.workDate === date)
        .reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
      const totalHours = parseFloat(on(preview).toFixed(2));
      // dates[] is Monday-first, so 5 and 6 are Saturday and Sunday. The floor is
      // a working-day expectation: applying it to the weekend would invent a 16h
      // shortfall every week and train the operator to ignore the warning.
      const isWorkday = i < 5;
      return {
        date,
        isWorkday,
        filedHours: parseFloat(on(filed).toFixed(2)),
        draftedHours: parseFloat(on(drafted).toFixed(2)),
        totalHours,
        // Positive means the day is short of the floor. Over the floor is fine.
        shortBy: isWorkday ? parseFloat(Math.max(0, minimum - totalHours).toFixed(2)) : 0,
      };
    });

    res.json({
      monday,
      weekStart: weekStartInstant(anchor),
      dates,
      // Fills the spec's `taxonomy` slot. Until Task 1's probe finds a live
      // taxonomy endpoint, the mapping file IS the list — the documented
      // fallback. The UI needs it so a drafted row can be re-attributed,
      // per billing-accuracy decision 7: attribution is a human step.
      projects: mapping.projects.map(({ label, projectId, activityId }) =>
        ({ label, projectId, activityId })),
      filed,
      drafted,
      replacedKeys,
      unmapped,
      byDay,
      dailyMinimumHours: minimum,
      resourceId: mapping.resourceId,
      mappingConfigured: mapping.projects.length > 0 && Boolean(mapping.resourceId),
      mappingError,
      fetchError,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-reads the week before merging: the operator's draft may be minutes old, and
// a stale union would erase anything edited in Sphere360's own UI meanwhile.
app.post('/api/sphere360/week', async (req, res) => {
  try {
    const { date, entries } = req.body || {};
    if (!date || !Array.isArray(entries)) {
      return res.status(400).json({ error: 'Body must be { date, entries[] }' });
    }

    const { mapping } = loadMapping();
    if (!mapping.resourceId) {
      return res.status(412).json({ error: 'No resourceId configured in the timesheet mapping' });
    }

    // Re-attribution in the UI can collapse two rows onto one key. Posting both
    // would file the same work twice, so reject it here rather than let the
    // union carry a duplicate.
    const keys = new Set();
    for (const e of entries) {
      const k = `${e.workDate}|${e.projectId ?? ''}|${e.activityId}`;
      if (keys.has(k)) {
        return res.status(400).json({
          error: `Two entries on ${e.workDate} share the same project and activity — merge them first`,
        });
      }
      keys.add(k);
    }

    const dates = new Set(weekDates(date));
    for (const e of entries) {
      if (!dates.has(e.workDate)) {
        return res.status(400).json({ error: `${e.workDate} is outside the posted week` });
      }
      if (!e.activityId) return res.status(400).json({ error: 'Every entry needs an activityId' });
      const h = Number(e.hours);
      if (!Number.isFinite(h) || h <= 0 || h > 24) {
        return res.status(400).json({ error: `Invalid hours ${JSON.stringify(e.hours)} on ${e.workDate}` });
      }
    }

    const client = createClient();
    const filed = await client.fetchWeek(weekStartInstant(date));
    const { entries: union, replaced } = mergeWeek({ filed, drafted: entries });

    await client.upsertWeek({
      weekStart: weekStartInstant(date),
      resourceId: mapping.resourceId,
      entries: union,
    });

    res.json({ weekStart: weekStartInstant(date), written: union.length, replaced: replaced.length });
  } catch (err) {
    const status = err.code === 'NO_TOKEN' ? 412 : err.code === 'AUTH' ? 401 : 502;
    res.status(status).json({ error: err.message, code: err.code });
  }
});
```

- [ ] **Step 5: Verify by curl**

```bash
cd backend && npm run dev &
sleep 2
curl -s localhost:8089/api/sphere360/mapping | head -c 300; echo
curl -s "localhost:8089/api/sphere360/week?date=2026-08-26" | head -c 600; echo
```

Expected with no mapping configured yet: `mapping` returns `source: "defaults"`, and `week` returns `mappingConfigured: false`, `drafted: []`, a 7-element `dates` array, a 7-element `byDay`, and a `fetchError` of code `NO_TOKEN` if `.env` is absent. **The route must still return 200** — a missing token is a reportable state, not a crash.

- [ ] **Step 6: Commit**

```bash
git add backend/server.js
git commit -m "feat(sphere360): add week draft and confirm routes"
```

---

### Task 8: Frontend types and the `TimesheetWeek` sheet

**Files:**
- Modify: `frontend/src/lib/types.ts` (append)
- Create: `frontend/src/components/TimesheetWeek.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/sphere360/week` from Task 7
- Produces: `<TimesheetWeek open onOpenChange />`, and the exported types below

> **Lint trap:** the ESLint baseline is exactly **1** error, from `App.tsx` calling
> `fetchData()` *synchronously* inside an effect (`react-hooks/set-state-in-effect`).
> Do not repeat that shape here. Define the async loader inside the effect and let
> every `setState` land after an `await`, which the rule does not flag. Verify the
> count is still 1 in Task 9, not 2.

- [ ] **Step 1: Add the types**

Append to `frontend/src/lib/types.ts`:

```typescript
// Sphere360 timesheet sync. `projectId` is optional because non-project rows
// (leave, social) exist in the timesheet — this app never authors them, but it
// must round-trip them untouched.
export interface TimesheetEntry {
  projectId?: string;
  activityId: string;
  workDate: string;
  hours: number;
  comments: string;
}

export interface DayTotals {
  date: string;
  isWorkday: boolean;  // false for Sat/Sun — the floor is a working-day concept
  filedHours: number;
  draftedHours: number;
  totalHours: number;
  shortBy: number;     // positive = below the floor; always 0 on a non-workday
}

export interface UnmappedFolder {
  projectPath: string;
  hours: number;
}

// Shape returned by GET /api/sphere360/week
export interface ProjectOption {
  label: string;
  projectId: string;
  activityId: string;
}

export interface WeekResponse {
  monday: string;
  weekStart: string;
  dates: string[];
  projects: ProjectOption[];
  filed: TimesheetEntry[];
  drafted: TimesheetEntry[];
  replacedKeys: string[];
  unmapped: UnmappedFolder[];
  byDay: DayTotals[];
  dailyMinimumHours: number;
  resourceId: string;
  mappingConfigured: boolean;
  mappingError: string | null;
  fetchError: { code: string; message: string } | null;
}
```

- [ ] **Step 2: Write the component**

Create `frontend/src/components/TimesheetWeek.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type { ProjectOption, TimesheetEntry, WeekResponse } from '@/lib/types';
import { localDateStr } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SubmitState = 'idle' | 'submitting' | 'done' | 'error';

const entryKey = (e: TimesheetEntry) => [e.workDate, e.projectId ?? '', e.activityId].join('|');

const shiftWeek = (monday: string, weeks: number) => {
  const [y, m, d] = monday.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + weeks * 7 * 86_400_000;
  const dt = new Date(ms);
  // UTC getters against a UTC-built instant: a calendar label, never a local shift.
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

// Splits by hand and builds a LOCAL date, exactly as formatDateLabel() in
// lib/utils.ts does: new Date('2026-07-20') parses as UTC midnight and renders
// as the previous day east of UTC.
const dayLabel = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
};

export function TimesheetWeek({ open, onOpenChange }: Props) {
  const [anchor, setAnchor] = useState<string>(() => localDateStr(new Date()));
  const [data, setData] = useState<WeekResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<Record<string, TimesheetEntry>>({});
  const [submit, setSubmit] = useState<SubmitState>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sphere360/week?date=${date}`);
      const body: WeekResponse = await res.json();
      setData(body);
      // Seed the editable copy from the server's draft on every load, so
      // switching weeks never carries another week's edits across.
      const seeded: Record<string, TimesheetEntry> = {};
      for (const e of body.drafted) seeded[entryKey(e)] = { ...e };
      setEdits(seeded);
      setSubmit('idle');
      setSubmitError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Async loader: every setState lands after an await, which keeps this clear
    // of react-hooks/set-state-in-effect. Do not hoist the call out of the effect.
    void load(anchor);
  }, [open, anchor, load]);

  const drafted = Object.values(edits);

  const dayTotal = (date: string) => {
    if (!data) return 0;
    const replaced = new Set(data.replacedKeys);
    const filed = data.filed
      .filter(e => e.workDate === date && !replaced.has(entryKey(e)))
      .reduce((s, e) => s + e.hours, 0);
    const mine = drafted.filter(e => e.workDate === date).reduce((s, e) => s + (Number(e.hours) || 0), 0);
    return parseFloat((filed + mine).toFixed(2));
  };

  const canConfirm =
    !!data && data.mappingConfigured && !data.fetchError &&
    drafted.length > 0 && drafted.every(e => e.projectId && e.activityId && Number(e.hours) > 0);

  const confirm = async () => {
    if (!data) return;
    setSubmit('submitting');
    setSubmitError(null);
    try {
      const res = await fetch('/api/sphere360/week', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: data.monday, entries: drafted }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setSubmitError(body.error || `HTTP ${res.status}`);
        setSubmit('error');
        return;
      }
      setSubmit('done');
      await load(anchor);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Request failed');
      setSubmit('error');
    }
  };

  // Recomputed from dayTotal(), not from data.byDay: the server's figures are a
  // snapshot from load time, and the day rows below already track live edits. A
  // footer reading server state would contradict the rows the moment an hours
  // field is touched.
  const weekLogged = data
    ? parseFloat(data.dates.reduce((s, d) => s + dayTotal(d), 0).toFixed(2))
    : 0;
  const weekFloor = data ? data.dailyMinimumHours * 5 : 0;
  const weekShort = parseFloat(Math.max(0, weekFloor - weekLogged).toFixed(2));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-3xl">
        <SheetTitle>Sphere360 timesheet</SheetTitle>
        <SheetDescription>
          Drafts this week's coding rows. Meetings and other work stay yours to add.
        </SheetDescription>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAnchor(shiftWeek(data?.monday ?? anchor, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium">
            {data ? `Week of ${dayLabel(data.monday)}` : '…'}
          </span>
          <Button variant="outline" size="sm" onClick={() => setAnchor(shiftWeek(data?.monday ?? anchor, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>

        {data?.fetchError && (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>{data.fetchError.message}</span>
          </div>
        )}

        {data && !data.mappingConfigured && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            No timesheet mapping yet. Add your resourceId and project roots to{' '}
            <code>~/.claude/session-jibble.timesheet.json</code> before drafting.
          </div>
        )}

        {data?.dates.map(date => {
          const replaced = new Set(data.replacedKeys);
          const filedRows = data.filed.filter(e => e.workDate === date);
          const myRows = drafted.filter(e => e.workDate === date);
          const total = dayTotal(date);
          const isWorkday = data.byDay.find(d => d.date === date)?.isWorkday ?? true;
          const short = isWorkday
            ? parseFloat(Math.max(0, data.dailyMinimumHours - total).toFixed(2))
            : 0;

          return (
            <div key={date} className="rounded-lg border p-3">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{dayLabel(date)}</span>
                <span className="text-xs text-muted-foreground">
                  minimum {data.dailyMinimumHours}h
                </span>
              </div>

              {filedRows.length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="text-xs uppercase text-muted-foreground">already filed</div>
                  {filedRows.map((e, i) => (
                    <div
                      key={`${entryKey(e)}-${i}`}
                      className={`flex justify-between text-sm ${
                        replaced.has(entryKey(e)) ? 'text-muted-foreground line-through' : ''
                      }`}
                    >
                      <span className="truncate pr-2">{e.comments.split('\n')[0] || '(no comment)'}</span>
                      <span className="tabular-nums">{e.hours.toFixed(2)} h</span>
                    </div>
                  ))}
                </div>
              )}

              {myRows.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="text-xs uppercase text-muted-foreground">
                    drafted from session-jibble
                    <span className="ml-2 rounded bg-amber-100 px-1 text-amber-800 normal-case">
                      ⚠ uncorrected
                    </span>
                  </div>
                  {myRows.map(e => {
                    const key = entryKey(e);
                    return (
                      <div key={key} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <select
                            className="rounded border px-2 py-1 text-sm"
                            value={`${e.projectId ?? ''}|${e.activityId}`}
                            onChange={ev => {
                              const [projectId, activityId] = ev.target.value.split('|');
                              setEdits(prev => ({
                                ...prev,
                                [key]: { ...prev[key], projectId, activityId },
                              }));
                            }}
                          >
                            {data.projects.map((p: ProjectOption) => (
                              <option key={`${p.projectId}|${p.activityId}`} value={`${p.projectId}|${p.activityId}`}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                          <input
                            className="w-20 rounded border px-2 py-1 text-sm tabular-nums"
                            type="number" step="0.01" min="0" max="24"
                            value={e.hours}
                            onChange={ev => setEdits(prev => ({
                              ...prev,
                              [key]: { ...prev[key], hours: parseFloat(ev.target.value) || 0 },
                            }))}
                          />
                          <span className="text-xs text-muted-foreground">hours</span>
                        </div>
                        <textarea
                          className="w-full rounded border px-2 py-1 text-sm"
                          rows={2}
                          value={e.comments}
                          onChange={ev => setEdits(prev => ({
                            ...prev,
                            [key]: { ...prev[key], comments: ev.target.value },
                          }))}
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 flex justify-between border-t pt-2 text-sm">
                <span>day total</span>
                <span className="tabular-nums">
                  {total.toFixed(2)} h{' '}
                  {short > 0
                    ? <span className="text-amber-700">⚠ {short.toFixed(2)} h below minimum</span>
                    : <span className="text-emerald-700">✓</span>}
                </span>
              </div>
            </div>
          );
        })}

        {data && data.unmapped.length > 0 && (
          <div className="rounded-md border p-3 text-sm">
            <div className="text-xs uppercase text-muted-foreground">not included</div>
            {data.unmapped.map(u => (
              <div key={u.projectPath} className="flex justify-between">
                <span className="truncate pr-2">{u.projectPath}</span>
                <span className="tabular-nums">{u.hours.toFixed(2)} h (unmapped)</span>
              </div>
            ))}
          </div>
        )}

        {data && (
          <div className="text-sm text-muted-foreground">
            {weekLogged.toFixed(2)} h logged
            {weekShort > 0 && ` · ${weekShort.toFixed(2)} h below the ${weekFloor.toFixed(0)} h floor`}
          </div>
        )}

        {submitError && (
          <div className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}

        <Button onClick={confirm} disabled={!canConfirm || submit === 'submitting'}>
          {submit === 'submitting' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submit === 'done' && <Check className="mr-2 h-4 w-4" />}
          {submit === 'done' ? 'Filed' : `Confirm and file ${drafted.length} row${drafted.length === 1 ? '' : 's'}`}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 3: Note the verified helper signatures**

Already confirmed against the tree — no need to re-check:
- `localDateStr(d: Date = new Date()): string` is exported from `frontend/src/lib/utils.ts:11`, so `localDateStr(new Date())` is correct.
- `Button` accepts `variant: 'default' | 'outline' | 'ghost' | 'link'` and `size: 'default' | 'sm' | 'lg'` (`ui/button.tsx:5-6`), so the `outline`/`sm` usages above are valid.

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: exits 0 with no output. **Not** `tsc --noEmit` — the solution config type-checks zero files and always passes.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/components/TimesheetWeek.tsx
git commit -m "feat(sphere360): add timesheet week draft sheet"
```

---

### Task 9: Mount the sheet and verify every gate

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `<TimesheetWeek />` from Task 8
- Produces: nothing downstream — this is the last task

- [ ] **Step 1: Mount the component**

In `frontend/src/App.tsx`, add the import beside the existing `SettingsPanel` import (line 8):

```tsx
import { TimesheetWeek } from '@/components/TimesheetWeek';
```

Add state beside the existing `selectedDates` state (line 35):

```tsx
const [timesheetOpen, setTimesheetOpen] = useState(false);
```

Render it next to `<SettingsPanel ... />` (around line 204):

```tsx
<TimesheetWeek open={timesheetOpen} onOpenChange={setTimesheetOpen} />
```

And add the trigger button in the header, beside whatever opens the settings sheet:

```tsx
<Button variant="outline" size="sm" onClick={() => setTimesheetOpen(true)}>
  Timesheet
</Button>
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Confirm the lint baseline did not move**

```bash
cd frontend && npx eslint . 2>&1 | tail -5
```

Expected: **exactly 1 error**, still `react-hooks/set-state-in-effect` in `App.tsx`. If the count is 2, the new effect in `TimesheetWeek` is calling `setState` synchronously — move every `setState` after an `await` rather than adding a suppression comment.

- [ ] **Step 4: Run the full backend suite**

```bash
cd backend && npm test
```

Expected: PASS — six pre-existing suites plus `sphere360-week`, `sphere360-mapping`, `sphere360-draft`, `sphere360-merge`, `sphere360-client`.

- [ ] **Step 5: End-to-end smoke test with a real mapping**

Create `~/.claude/session-jibble.timesheet.json` with the operator's real `resourceId`, one project root, and the `projectId`/`activityId` from the reference payload. Then:

```bash
curl -s "localhost:8089/api/sphere360/week?date=2026-08-26" | python3 -m json.tool | head -60
```

Confirm: `mappingConfigured: true`, `drafted[]` non-empty, `byDay` has 7 rows, and a day over 8h reports `shortBy: 0`. **Do not POST** until the operator has reviewed the draft in the UI.

- [ ] **Step 6: Document the feature in CLAUDE.md**

Add to the "Data sources" table:

```markdown
| `session-jibble.timesheet.json` | Folder→Sphere360 project/activity prefills (not a Claude file) |
```

And a section after "Transcript ingestion":

```markdown
### Sphere360 timesheet sync
`TimesheetWeek` drafts the week's coding rows into Sphere360's week-scoped
`/api/timesheets/upsert`, and never writes without an operator confirming.

The endpoint replaces the whole week, so `lib/sphere360/merge.js` unions drafted
rows onto everything already filed and refuses to post a union that lost a row.
Meetings, scrums and leave are invisible to this app and must survive every write —
that is what `sphere360-merge.test.js` exists to protect.

Drafted hours are **uncorrected**: `docs/billing-accuracy-plan.md` measures the
current engine ~25% high, and those corrections have not landed. `draft.js` takes
hours through an injected `hoursFor()`, so the corrected engine drops in without
touching the sync. The UI labels every drafted row until then.

`SPHERE360_TOKEN` lives in `backend/.env` (gitignored) and is read at call time,
so a re-pasted token needs no restart. 8h is a **floor**, not a target — only a
short day is flagged, and it never blocks confirm.
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.tsx CLAUDE.md
git commit -m "feat(sphere360): mount timesheet sheet and document the sync"
```
