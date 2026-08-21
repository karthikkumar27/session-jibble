export interface Session {
  sessionId: string;
  project: string;
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
}

// One session on one specific calendar day. A session active on three selected
// days yields three of these — hours are never summed across days.
export interface SessionDay {
  date: string;
  hours: number;
  session: Session;
}
