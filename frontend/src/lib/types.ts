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
  byDay: DayTotals[];
  dailyMinimumHours: number;
  resourceId: string;
  mappingConfigured: boolean;
  mappingError: string | null;
  fetchError: { code: string; message: string } | null;
}
