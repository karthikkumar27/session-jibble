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
