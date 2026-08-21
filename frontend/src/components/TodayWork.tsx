import { Clock, FolderGit2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { localDateStr } from '@/lib/utils';
import type { Session } from '@/lib/types';

interface Props {
  sessions: Session[];
}

export function TodayWork({ sessions }: Props) {
  const today = localDateStr();
  // activeDates includes all days the session sent messages — catches sessions
  // that started yesterday but continued into today
  const todaySessions = sessions.filter(s => s.activeDates?.includes(today));

  if (todaySessions.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">No sessions recorded today yet.</div>
    );
  }

  // Group by project, summing only the hours worked TODAY. Using durationHours
  // here would add a multi-day session's entire lifetime to today's total — a
  // session that ran 5h yesterday and 10 min today would report 5.2h.
  const byProject: Record<string, { hours: number; sessions: Session[] }> = {};
  for (const s of todaySessions) {
    if (!byProject[s.project]) byProject[s.project] = { hours: 0, sessions: [] };
    byProject[s.project].hours += s.dailyActive?.[today] ?? 0;
    byProject[s.project].sessions.push(s);
  }

  const formatHours = (h: number) => {
    if (h < 1) return `${Math.round(h * 60)}m`;
    return `${h.toFixed(1)}h`;
  };

  return (
    <div className="flex flex-wrap gap-3">
      {Object.entries(byProject).map(([project, data]) => {
        const allDone = data.sessions.every(s => s.status === 'completed');
        const anyDone = data.sessions.some(s => s.status === 'completed');
        return (
          <div
            key={project}
            className="flex items-center gap-2 rounded-lg border bg-card px-4 py-2.5 shadow-sm"
          >
            <FolderGit2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-semibold text-sm">{project}</span>
            <div className="flex items-center gap-1 text-muted-foreground text-xs">
              <Clock className="h-3 w-3" />
              {formatHours(data.hours)}
            </div>
            <Badge variant={allDone ? 'success' : anyDone ? 'secondary' : 'default'}>
              {allDone ? 'Done' : anyDone ? 'Partial' : 'Active'}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}
