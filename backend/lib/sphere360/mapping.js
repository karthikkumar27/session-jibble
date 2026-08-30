const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_OPTIONS, normalizePath, matchesRoot } = require('../categorize');
const { isValidLocalDate } = require('./week');

const MAPPING_FILE = path.join(os.homedir(), '.claude', 'session-jibble.timesheet.json');
const MAPPING_VERSION = 1;
const DEFAULT_MINIMUM_HOURS = 8;
const MAX_PROJECTS = 100;
const MAX_HOLIDAYS = 100;

// Empty on purpose, exactly as config.js is: seeding one person's projectIds
// would be wrong for everyone else, and a wrong projectId files real hours
// against the wrong client. holidays is empty for the same reason a stale
// list is worse than none — it would silently waive an obligation on a day
// that turned out to be a normal working day.
const DEFAULT_MAPPING = {
  version: MAPPING_VERSION,
  resourceId: '',
  projects: [],
  dailyMinimumHours: DEFAULT_MINIMUM_HOURS,
  holidays: [],
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
    holidays: [],
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

  // Optional. Absent or empty means "no holidays configured" — not an error —
  // because there is no holiday endpoint to seed from (all four probed paths
  // 404): every entry here is hand-maintained, and most operators will have
  // none yet. Placed after dailyMinimumHours and before the project loop on
  // purpose: several existing tests assert errors[0].path against that order,
  // and this must not shift it.
  if (raw.holidays !== undefined) {
    if (!Array.isArray(raw.holidays)) {
      errors.push({ path: 'holidays', message: '"holidays" must be an array' });
    } else if (raw.holidays.length > MAX_HOLIDAYS) {
      errors.push({ path: 'holidays', message: `At most ${MAX_HOLIDAYS} holidays allowed` });
    } else {
      // A repeat is noise, not a mistake — unlike a root double-claimed by two
      // projects, two identical holiday dates don't create any ambiguity to
      // report. Silently folded to one, consistent with how roots behaves.
      const seen = new Set();
      raw.holidays.forEach((h, i) => {
        const at = `holidays[${i}]`;
        // isValidLocalDate is week.js's own shape-AND-calendar check, reused
        // rather than re-implemented: a second '2026-02-30' trap here could
        // drift from the one week.js already closes.
        if (typeof h !== 'string' || !isValidLocalDate(h)) {
          errors.push({ path: at, message: 'Must be a valid YYYY-MM-DD date' });
          return;
        }
        if (seen.has(h)) return;
        seen.add(h);
        out.holidays.push(h);
      });
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

// A Mon-Fri public holiday is not a working day, but nothing upstream of this
// knows that on its own — the caller (server.js's byDay) supplies the
// candidate date, this just answers whether it is one of the configured ones.
// `date` is expected to already be a validated YYYY-MM-DD local date (every
// caller in this codebase gets one from week.js's weekDates), so this does a
// plain membership check rather than re-validating it.
function isHoliday(date, mapping) {
  return Array.isArray(mapping?.holidays) && mapping.holidays.includes(date);
}

// Sphere360 declares the operator's own weekly capacity on the week response
// (observed weeklyCapacityHours: 40) — the daily floor should come from that,
// not a hardcoded 8. A week with no timesheet yet (client.js returns
// week: null for it) carries no resource, so this falls back to the mapping's
// configured dailyMinimumHours, which itself defaults to 8.
//
// Returns { hours, source } rather than just a number so the GET route can be
// honest with the UI about which one produced the figure on screen.
function resolveDailyMinimum(mapping, week) {
  const capacity = week?.resource?.weeklyCapacityHours;
  if (typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0) {
    return { hours: capacity / 5, source: 'sphere360' };
  }
  return { hours: mapping.dailyMinimumHours, source: 'config' };
}

module.exports = {
  MAPPING_FILE, MAPPING_VERSION, DEFAULT_MAPPING,
  validateMapping, loadMapping, saveMapping, resolveProject,
  isHoliday, resolveDailyMinimum,
};
