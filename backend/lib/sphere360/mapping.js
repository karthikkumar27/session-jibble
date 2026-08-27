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
