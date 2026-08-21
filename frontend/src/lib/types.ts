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
