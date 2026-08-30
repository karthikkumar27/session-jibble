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

export interface Session {
  sessionId: string;
  project: string;
  category: Category;
  date: string;            // session start date
  lastActiveDate: string;  // most recent day with activity — used as display date
  activeDates: string[];   // all calendar days this session sent messages
  dailyActive: Record<string, number>; // date → active hours on that date; sums to durationHours
  durationHours: number;
  durationMinutes: number;
  status: 'in-progress' | 'completed';
  excerpt: string;
  startedAt: number;
  lastActivityAt: number;
}

// Shape returned by GET /api/daily-stats
export interface DayStats {
  date: string;
  hours: number;
  workHours: number;
  nonWorkHours: number;
  uncategorizedHours: number;
}

// One session on one specific calendar day. A session active on three selected
// days yields three of these — hours are never summed across days.
export interface SessionDay {
  date: string;
  hours: number;
  session: Session;
}

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
  isWorkday: boolean;   // false for Sat/Sun ONLY — a holiday does not clear it,
                         // matching Sphere360's own working-day count
  isHoliday: boolean;   // a LABEL, not an exemption — see shortBy
  filedHours: number;
  draftedHours: number;
  totalHours: number;
  shortBy: number;     // positive = below the floor; always 0 when !isWorkday
}

export interface UnmappedFolder {
  projectPath: string;
  hours: number;
}

// A day the sync's cutover kept out of the draft, with what this app measured
// on it. Reported rather than dropped: a day that shows no drafted row and no
// explanation reads as a broken measurement, not as a deliberate boundary.
export interface BeforeCutoverDay {
  date: string;
  hours: number;   // measured here, filed nowhere by this app
}

// Shape returned by GET /api/sphere360/week
export interface ProjectOption {
  label: string;
  projectId: string;
  activityId: string;
}

// Sphere360's own state for the week. The server sends `writable` already
// decided rather than the raw fields alone: the rule that governs the write
// lives on the server, and a second copy of it here is a second copy to drift.
export interface WeekState {
  status: string | null;
  isUnlocked: boolean | null;
  submittedAt: string | null;
  approvedAt: string | null;
  writable: boolean;
}

export interface WeekResponse {
  monday: string;
  weekStart: string;
  dates: string[];
  // null when no timesheet exists for the week yet — the freest state, not the
  // most restricted, so it must not be conflated with a locked one.
  week: WeekState | null;
  projects: ProjectOption[];
  filed: TimesheetEntry[];
  drafted: TimesheetEntry[];
  replacedKeys: string[];
  unmapped: UnmappedFolder[];
  // The date this sync starts from — everything earlier belongs to the
  // operator's previous timesheet (Jibble) and is never drafted or written.
  // null means no cutover is configured, so every date is eligible.
  syncFrom: string | null;
  beforeCutover: BeforeCutoverDay[];
  byDay: DayTotals[];
  dailyMinimumHours: number;   // the effective value in use — see dailyMinimumSource
  dailyMinimumSource: 'sphere360' | 'config';
  resourceId: string;
  mappingConfigured: boolean;
  mappingError: string | null;
  fetchError: { code: string; message: string } | null;
}

// Sphere360's own "MY BILLABLE PROGRESS" card, for the 26th-to-25th billing
// cycle the viewed week falls in. Shape returned by GET /api/sphere360/cycle.
export interface CycleAllocation {
  projectId: string;
  projectCode: string;
  project: string;
  projectStatus: string;
  plannedMandays: number;   // this cycle's plan, NOT the project's whole-life total
}

export interface WeekFetchError {
  weekStart: string;
  code: string | null;
  message: string;
}

export interface CycleResponse {
  cycle: { start: string; end: string; monthKey: string; label: string };
  workingDays: number;          // plain Mon-Fri; holidays are NOT deducted
  elapsedWorkingDays: number;
  remainingWorkingDays: number;
  dailyHours: number;           // also Sphere360's "days" unit — see dailyHoursSource
  dailyHoursSource: 'sphere360' | 'config';
  capacityHours: number;
  // null when no week in the cycle carried a resource: there is no sensible
  // default for a utilisation target, and inventing one would show the operator
  // a figure Sphere360 never stated.
  targetPercent: number | null;
  // Rounded to ONE decimal by Sphere360 before it becomes hours (0.73 x 23 =
  // 16.79 -> 16.8 -> 134.4h). Render it `.toFixed(2)` — the card's "16.80
  // days" is a two-decimal rendering of a one-decimal value, which is its
  // formatting, not a mistake. Never re-derive it as targetHours/dailyHours:
  // that puts the unrounded value back.
  targetDays: number | null;
  targetHours: number | null;
  billedHours: number;          // filed AND billable only
  billableDays: number;
  actualPercent: number;
  // What session-jibble measured over the cycle. OVERLAPS billedHours — most of
  // it is the same work, already filed. Never add the two.
  measuredHours: number;
  allocations: CycleAllocation[];
  allocationsError: { code: string | null; message: string } | null;
  // Per-week failures. Non-empty means the totals above are partial, not wrong.
  weekErrors: WeekFetchError[];
}
