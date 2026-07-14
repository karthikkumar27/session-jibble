export interface Session {
  sessionId: string;
  project: string;
  date: string;            // session start date
  lastActiveDate: string;  // most recent day with activity — used as display date
  activeDates: string[];   // all calendar days this session sent messages
  durationHours: number;
  durationMinutes: number;
  status: 'in-progress' | 'completed';
  excerpt: string;
  startedAt: number;
  lastActivityAt: number;
}

export interface DayStats {
  date: string;
  hours: number;
  sessions: number;
}
