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
