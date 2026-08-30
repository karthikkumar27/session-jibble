const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const os = require('os');
const { classifyProject } = require('./lib/categorize');
const {
  loadConfig, saveConfig, validateConfig, isUnconfigured,
} = require('./lib/config');

// Node 22 ships this, so the Sphere360 token needs no dotenv dependency.
// Absent .env is normal — the sync routes report a missing token themselves.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env yet */ }

const { weekDates, mondayOf, weekStartInstant } = require('./lib/sphere360/week');
const { cycleFor, weekStartsIn, datesIn, cycleLabel } = require('./lib/sphere360/cycle');
const { summarizeCycle } = require('./lib/sphere360/progress');
const {
  loadMapping, saveMapping, validateMapping, resolveDailyMinimum, isHoliday, beforeCutover,
} = require('./lib/sphere360/mapping');
const { buildDraft } = require('./lib/sphere360/draft');
const { mergeWeek, entryKey, weekWritable, stripClientIdentity, foreignWorkDate } = require('./lib/sphere360/merge');
const { createClient } = require('./lib/sphere360/client');

const app = express();

// This API is unauthenticated and serves the user's entire session history along
// with absolute project paths — which disclose their username, home layout, and
// every client and repo name. A wildcard origin would let any page they happen to
// be browsing read all of that, and drive the write endpoints too. Requests that
// arrive through Vite's /api proxy are same-origin and unaffected; this only
// governs pages talking to :8089 directly.
const ALLOWED_ORIGINS = ['http://localhost:8088', 'http://127.0.0.1:8088'];
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const STATS_FILE = path.join(CLAUDE_DIR, 'session-stats.json');

// 30-minute idle threshold — gaps longer than this aren't counted as active time
const GAP_THRESHOLD = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Date helpers — all use the SERVER's local timezone (= user's machine clock).
// Never use toISOString() for date labels: that returns UTC and will shift
// dates for users in UTC+N timezones (e.g. UTC+8 Malaysia).
// ---------------------------------------------------------------------------

function toLocalDate(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Returns the Unix ms of local midnight at the START of the NEXT day after ts.
function nextLocalMidnight(ts) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0); // rolls forward to 00:00:00 of the next local day
  return d.getTime();
}

// ---------------------------------------------------------------------------

function cwdToProjectDir(cwd) {
  return cwd.replace(/[/. ]/g, '-');
}

function getSessionTimes() {
  const map = {};
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
        if (data.sessionId) {
          map[data.sessionId] = { startedAt: data.startedAt, updatedAt: data.updatedAt };
        }
      } catch {}
    }
  } catch {}
  return map;
}

function getAiTitle(projectDir, sessionId) {
  const transcriptPath = path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) return '';
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'ai-title' && entry.aiTitle) return entry.aiTitle;
      } catch {}
    }
  } catch {}
  return '';
}

function loadCompletionOverrides() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveCompletionOverrides(overrides) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(overrides, null, 2));
}

function readHistory() {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Group history entries by session, with timestamps sorted ascending.
// Shared by both endpoints so they always agree on session membership.
function groupSessionsFromHistory(history) {
  const groups = {};
  for (const entry of history) {
    if (!entry.sessionId) continue;
    if (!groups[entry.sessionId]) {
      groups[entry.sessionId] = {
        project: entry.project || '',
        timestamps: [],
        firstDisplay: entry.display || ''
      };
    }
    if (entry.timestamp) groups[entry.sessionId].timestamps.push(entry.timestamp);
  }
  for (const group of Object.values(groups)) {
    group.timestamps.sort((a, b) => a - b);
  }
  return groups;
}

// Attribute active ms to byDay map, splitting correctly at local midnight boundaries.
// Example: msg at 11:58 PM → msg at 12:05 AM (7 min gap, < threshold)
//   → 2 min to the first day, 5 min to the second day.
function attributeGap(byDay, tsA, tsB) {
  const gap = tsB - tsA;
  if (gap <= 0 || gap >= GAP_THRESHOLD) return;

  const dayA = toLocalDate(tsA);
  const dayB = toLocalDate(tsB);

  if (dayA === dayB) {
    // Same local day — no split needed
    byDay[dayA] = (byDay[dayA] || 0) + gap;
  } else {
    // Straddles one or more local midnights — walk forward day by day
    let cursor = tsA;
    while (toLocalDate(cursor) !== dayB) {
      const midnight = nextLocalMidnight(cursor);
      const portion = Math.min(midnight, tsB) - cursor;
      const day = toLocalDate(cursor);
      byDay[day] = (byDay[day] || 0) + portion;
      cursor = midnight;
    }
    // Remaining time in dayB
    const remaining = tsB - cursor;
    if (remaining > 0) byDay[dayB] = (byDay[dayB] || 0) + remaining;
  }
}

// Active ms per local calendar day for ONE session's sorted timestamps.
// Summing the values gives the session's total active time, so per-day and
// total figures can never drift apart.
function activeMsByDay(sortedTs) {
  const byDay = {};
  for (let i = 1; i < sortedTs.length; i++) {
    attributeGap(byDay, sortedTs[i - 1], sortedTs[i]);
  }
  return byDay;
}

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

function parseClaudeData() {
  const { config } = loadConfig();
  const sessionGroups = groupSessionsFromHistory(readHistory());

  const sessionTimes = getSessionTimes();
  const overrides = loadCompletionOverrides();
  const sessions = [];

  for (const [sessionId, group] of Object.entries(sessionGroups)) {
    const { project, timestamps, firstDisplay } = group;

    // Per-day breakdown first; the session total is its sum. This is what lets
    // the UI ask "how long was this session active on day X" without
    // over-counting a multi-day session's other days.
    const msByDay = activeMsByDay(timestamps);
    const totalActiveMs = Object.values(msByDay).reduce((sum, ms) => sum + ms, 0);
    const dailyActive = {};
    for (const [day, ms] of Object.entries(msByDay)) {
      dailyActive[day] = parseFloat((ms / 3_600_000).toFixed(2));
    }

    const startMs = timestamps.length
      ? timestamps[0]
      : (sessionTimes[sessionId]?.startedAt || 0);

    const projectName = project ? path.basename(project) : 'unknown';
    const date = toLocalDate(startMs);                          // local date, not UTC
    const projectDir = project ? cwdToProjectDir(project) : '';
    const aiTitle = projectDir ? getAiTitle(projectDir, sessionId) : '';
    const excerpt = (aiTitle || firstDisplay || '').slice(0, 100);

    // Local calendar days this session had any messages, sorted ascending
    const activeDates = [...new Set(timestamps.map(ts => toLocalDate(ts)))].sort();
    // Most recent day with activity — used as the display date and for sorting
    const lastActiveDate = activeDates[activeDates.length - 1] || date;
    const lastActivityAt = timestamps[timestamps.length - 1] || startMs;

    sessions.push({
      sessionId,
      project: projectName,
      category: classifyProject(project, config),
      date,           // session start date (kept for reference)
      lastActiveDate, // most recent day with messages — used in the table Date column
      activeDates,
      dailyActive,    // local date → active hours on that date (sums to durationHours)
      durationHours: parseFloat((totalActiveMs / 3_600_000).toFixed(2)),
      durationMinutes: Math.round(totalActiveMs / 60_000),
      status: overrides[sessionId]?.status || 'in-progress',
      excerpt,
      startedAt: startMs,
      lastActivityAt
    });
  }

  // Sort by most recent activity first, not session start — so a session
  // started last week but active today ranks above yesterday's sessions.
  return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

// Daily stats: correctly attribute every active minute to the local calendar day
// it occurred in, splitting pairs that straddle midnight at the boundary.
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
    const sessionByDay = activeMsByDay(timestamps);

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

app.get('/api/stats', (req, res) => {
  try {
    res.json(parseClaudeData());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily-stats', (req, res) => {
  try {
    res.json(parseDailyStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:sessionId/done', (req, res) => {
  try {
    const overrides = loadCompletionOverrides();
    overrides[req.params.sessionId] = { status: 'completed' };
    saveCompletionOverrides(overrides);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:sessionId/reopen', (req, res) => {
  try {
    const overrides = loadCompletionOverrides();
    overrides[req.params.sessionId] = { status: 'in-progress' };
    saveCompletionOverrides(overrides);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// The week's own state, as the UI needs it. `writable` is sent decided rather
// than as raw fields for the frontend to re-derive: the rule that governs the
// write lives on the server, and a second copy of it in TypeScript is a second
// copy to drift.
function weekSummary(week) {
  if (!week) return null;
  const { status = null, isUnlocked = null, submittedAt = null, approvedAt = null } = week;
  return { status, isUnlocked, submittedAt, approvedAt, writable: weekWritable(week) };
}

// Reads a week and returns it merged in preview: what is filed, what this app
// would draft, and what the day totals become. Nothing is written.
app.get('/api/sphere360/week', async (req, res) => {
  try {
    const anchor = req.query.date || toLocalDate(Date.now());
    const monday = mondayOf(anchor);
    const dates = weekDates(anchor);
    const { mapping, error: mappingError } = loadMapping();

    // fetchWeek returns { week, entries }: the wrapper is not decoration, it is
    // the only carrier of the week's status. Destructuring the entries out of it
    // is what stops week wrappers being merged as if they were rows.
    let filed = [];
    let filedWeek = null;
    let fetchError = null;
    try {
      ({ week: filedWeek, entries: filed } = await createClient().fetchWeek(weekStartInstant(anchor)));
    } catch (err) {
      fetchError = { code: err.code, message: err.message };
    }

    const { sessions, hoursFor } = weekActivity(dates);
    // beforeCutoverDays, not `beforeCutover`: the imported predicate of that
    // name is what the POST route refuses with, and shadowing it here would
    // silently disarm the guard if these two routes ever move closer together.
    const { entries: drafted, unmapped, beforeCutover: beforeCutoverDays } =
      buildDraft({ anyDateInWeek: anchor, sessions, mapping, hoursFor });

    const { entries: preview, replaced } = mergeWeek({ filed, drafted });
    const replacedKeys = replaced.map(entryKey);

    // The floor itself: Sphere360's own weeklyCapacityHours (on filedWeek.resource)
    // beats the mapping's configured fallback whenever a timesheet exists for the
    // week. dailyMinimumSource rides along in the response so the UI is never
    // silently wrong about which one produced the number on screen.
    const { hours: minimum, source: dailyMinimumSource } = resolveDailyMinimum(mapping, filedWeek);
    const byDay = dates.map((date, i) => {
      const on = (list) => list.filter(e => e.workDate === date)
        .reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
      const totalHours = parseFloat(on(preview).toFixed(2));
      // dates[] is Monday-first, so 5 and 6 are Saturday and Sunday. isWorkday
      // is plain Mon-Fri and does NOT exclude a holiday: Sphere360's own "MY
      // BILLABLE PROGRESS" card counts every Mon-Fri date in a cycle as a
      // working day regardless of public holidays (verified against a live
      // cycle spanning two — Merdeka and Malaysia Day — that still counted
      // all 23), and its 73% target utilisation is exactly the slack that
      // already absorbs holidays, leave and non-billable time. Excluding a
      // holiday here too would double-count that allowance and make our
      // figures disagree with the dashboard that feeds it. isHoliday is
      // still surfaced so the UI can LABEL the day — it must not be read as
      // a second isWorkday.
      const holiday = isHoliday(date, mapping);
      const isWorkday = i < 5;
      return {
        date,
        isWorkday,
        isHoliday: holiday,
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
      // null when no timesheet exists for the week — a state the UI must be able
      // to tell apart from a locked one, since it is the freest state, not the
      // most restricted.
      week: weekSummary(filedWeek),
      filed,
      drafted,
      replacedKeys,
      unmapped,
      // The Jibble cutover, and the days it kept out of the draft. Both are
      // sent so the UI can explain an empty day rather than let it read as a
      // measurement that failed: null syncFrom means no cutover at all.
      syncFrom: mapping.syncFrom ?? null,
      beforeCutover: beforeCutoverDays,
      byDay,
      dailyMinimumHours: minimum,
      dailyMinimumSource,
      resourceId: mapping.resourceId,
      mappingConfigured: mapping.projects.length > 0 && Boolean(mapping.resourceId),
      mappingError,
      fetchError,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Sphere360's "MY BILLABLE PROGRESS" card for the cycle the given date falls
// in, recomputed from the weeks that cycle spans.
//
// Read-only. Every figure comes from summarizeCycle (lib/sphere360/progress.js)
// so it is testable against the operator's live card without a network call;
// this route only fetches, and decides nothing.
app.get('/api/sphere360/cycle', async (req, res) => {
  const anchor = req.query.date || toLocalDate(Date.now());

  // `date` is free text from a URL. cycleFor validates through week.js, which
  // refuses a calendar-invalid date rather than sliding it into another cycle.
  let cycle;
  try {
    cycle = cycleFor(anchor);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const { mapping } = loadMapping();
    const client = createClient();

    // In parallel, not in sequence: a cycle spans five weeks, and six serial
    // round trips to a corporate VPN endpoint is the difference between a card
    // that renders with the sheet and one the operator waits for.
    //
    // Each week is caught individually. One expired token or 500 must not blank
    // a card used to judge whether the operator is behind — the totals come
    // from the weeks that succeeded, and weekErrors names the rest so the UI
    // can say the figure is partial.
    const [weeks, plan] = await Promise.all([
      Promise.all(weekStartsIn(cycle.start, cycle.end).map(async (weekStart) => {
        try {
          const { week, entries } = await client.fetchWeek(weekStartInstant(weekStart));
          return { weekStart, week, entries };
        } catch (err) {
          return { weekStart, error: { code: err.code ?? null, message: err.message } };
        }
      })),
      // Caught the same way and for the same reason. An empty allocations list
      // means "nothing planned"; a failure must not be rendered as that.
      client.fetchPlanVsActual(cycle.monthKey).then(
        ({ allocations }) => ({ allocations, error: null }),
        (err) => ({ allocations: [], error: { code: err.code ?? null, message: err.message } }),
      ),
    ]);

    const summary = summarizeCycle({ cycle, today: toLocalDate(Date.now()), weeks, mapping });

    // What THIS app measured over the cycle's dates. It is not additive with
    // billedHours — most of it is the same work, already filed — so it is named
    // and labelled as a measurement, never as an amount outstanding.
    //
    // hoursFor already sums across concurrent sessions for a (projectPath,
    // date) pair, so the pairs are deduped before summing: adding per session
    // would count two sessions in one repo on one day twice.
    const { sessions, hoursFor } = weekActivity(datesIn(cycle.start, cycle.end));
    const datesByProject = new Map();
    for (const s of sessions) {
      if (!s.projectPath) continue;
      if (!datesByProject.has(s.projectPath)) datesByProject.set(s.projectPath, new Set());
      for (const d of s.dates ?? []) datesByProject.get(s.projectPath).add(d);
    }
    let measured = 0;
    for (const [projectPath, dates] of datesByProject) {
      for (const date of dates) measured += hoursFor(projectPath, date);
    }

    res.json({
      cycle: { ...cycle, label: cycleLabel(cycle.start, cycle.end) },
      ...summary,
      measuredHours: parseFloat(measured.toFixed(2)),
      allocations: plan.allocations,
      allocationsError: plan.error,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-reads the week before merging: the operator's draft may be minutes old, and
// a stale union would erase anything edited in Sphere360's own UI meanwhile.
app.post('/api/sphere360/week', async (req, res) => {
  try {
    const { date, entries: rawEntries } = req.body || {};
    if (!date || !Array.isArray(rawEntries)) {
      return res.status(400).json({ error: 'Body must be { date, entries[] }' });
    }

    // Identity is assigned only by mergeWeek, from a filed row it matched by
    // key — never accepted from the request. Nothing sends id/timesheetId
    // today, but a row that did would otherwise pass through untouched and
    // could overwrite an arbitrary filed row instead of the one it matches.
    const entries = stripClientIdentity(rawEntries);

    const { mapping } = loadMapping();
    if (!mapping.resourceId) {
      return res.status(412).json({ error: 'No resourceId configured in the timesheet mapping' });
    }

    // Re-attribution in the UI can collapse two rows onto one key. Posting both
    // would file the same work twice, so reject it here rather than let the
    // union carry a duplicate.
    const keys = new Set();
    for (const e of entries) {
      // entryKey(), never a hand-rolled format: this check must agree with the
      // ownership key mergeWeek() uses, character for character. The two drifted
      // once already — join('|') renders a missing activityId as "" where a
      // template literal renders "undefined".
      const k = entryKey(e);
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
      // The Jibble boundary, enforced before a single network call. draft.js
      // already keeps these dates out of the draft, but that filter is a
      // DEFAULT and this is the GUARANTEE: a UI bug, a stale tab or a
      // hand-rolled request must not be able to reach into a period closed in
      // another system. 409 rather than 400 because nothing about the request
      // is malformed — it conflicts with a boundary the request cannot see,
      // exactly like the NOT_WRITABLE refusal below.
      if (beforeCutover(e.workDate, mapping)) {
        return res.status(409).json({
          code: 'BEFORE_CUTOVER',
          error: `${e.workDate} is before this sync's start date of ${mapping.syncFrom} — that period was kept in Jibble and is not filed from here.`,
        });
      }
      if (!e.activityId) return res.status(400).json({ error: 'Every entry needs an activityId' });
      const h = Number(e.hours);
      if (!Number.isFinite(h) || h <= 0 || h > 24) {
        return res.status(400).json({ error: `Invalid hours ${JSON.stringify(e.hours)} on ${e.workDate}` });
      }
    }

    const client = createClient();
    const { week, entries: filed } = await client.fetchWeek(weekStartInstant(date));

    // Checked on the re-read, not on the draft the operator loaded: the week may
    // have been submitted minutes ago, and this endpoint replaces it wholesale.
    // 409, because nothing about the request is malformed — the week's state
    // conflicts with it, and unlocking the week in Sphere360 makes the same
    // request valid. Evaluated BEFORE upsertWeek, so a refusal writes nothing.
    if (!weekWritable(week)) {
      const state = week.status ? `is ${week.status}` : 'is in an unrecognised state';
      return res.status(409).json({
        code: 'NOT_WRITABLE',
        error: `The Sphere360 week of ${mondayOf(date)} ${state} and is not unlocked, so it cannot be filed from here. Unlock or reopen it in Sphere360 and try again.`,
        week: weekSummary(week),
      });
    }

    const { entries: union, replaced } = mergeWeek({ filed, drafted: entries });

    // The union includes filed rows straight from the API, which the request
    // validation above never saw. If the API ever returned something outside
    // the week actually requested, refuse the whole write rather than file a
    // foreign-dated row into it or silently drop it — 409 because unlocking or
    // correcting the week and retrying is the recoverable path, and nothing
    // about the request itself is malformed.
    const foreign = foreignWorkDate(union, dates);
    if (foreign) {
      return res.status(409).json({
        code: 'FOREIGN_DATE',
        error: `Sphere360 returned a row dated ${foreign}, outside the week of ${mondayOf(date)}; the week was not written.`,
      });
    }

    // Checked against the UNION for the same reason foreignWorkDate is: it
    // carries filed rows straight from the API that the request validation
    // above never saw, and upsert replaces the week wholesale — so a filed row
    // dated inside the Jibble period would be re-written by this POST even
    // though this app never drafted it. Refuse the whole write; a week
    // straddling the cutover is not this system's to replace.
    const early = union.find(row => beforeCutover(row.workDate, mapping));
    if (early) {
      return res.status(409).json({
        code: 'BEFORE_CUTOVER',
        error: `The week carries a row dated ${early.workDate}, before this sync's start date of ${mapping.syncFrom}; the week was not written.`,
      });
    }

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

const PORT = 8089;
// Bind loopback only. Without an explicit host Express listens on every interface,
// so anyone on the same network (a cafe, a shared office WiFi) could read this
// machine's session history unauthenticated.
const HOST = '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`Claude stats backend running on ${HOST}:${PORT}`));
