import { useState } from 'react';
import { CheckCircle2, RotateCcw, CalendarRange } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { localDateStr } from '@/lib/utils';
import type { Session } from '@/lib/types';

interface Props {
  sessions: Session[];
  onStatusChange: (sessionId: string, status: 'completed' | 'in-progress') => void;
}

const formatDuration = (hours: number, minutes: number) => {
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
};

export function SessionsTable({ sessions, onStatusChange }: Props) {
  const [page, setPage] = useState(0);
  const today = localDateStr();
  const PAGE_SIZE = 20;
  const pageCount = Math.ceil(sessions.length / PAGE_SIZE);
  const visible = sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <Card>
      <CardHeader>
        <CardTitle>All Sessions</CardTitle>
        <CardDescription>
          {sessions.length} sessions total · sorted by most recent activity
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Last Active</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Project</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Duration</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Excerpt</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s, i) => {
                const isToday = s.lastActiveDate === today;
                const spansMultipleDays = s.activeDates.length > 1;
                return (
                  <tr
                    key={s.sessionId}
                    className={`border-b transition-colors hover:bg-muted/30 ${
                      isToday ? 'bg-blue-50/40' : i % 2 === 0 ? '' : 'bg-muted/10'
                    }`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={isToday ? 'font-semibold text-blue-700' : 'text-muted-foreground'}>
                        {s.lastActiveDate}
                      </span>
                      {spansMultipleDays && (
                        <span
                          className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground"
                          title={`Started ${s.date} · active on ${s.activeDates.join(', ')}`}
                        >
                          <CalendarRange className="h-3 w-3" />
                          {s.activeDates.length}d
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium whitespace-nowrap">{s.project}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatDuration(s.durationHours, s.durationMinutes)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={s.status === 'completed' ? 'success' : 'secondary'}>
                        {s.status === 'completed' ? 'Completed' : 'In Progress'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 max-w-xs truncate text-muted-foreground" title={s.excerpt}>
                      {s.excerpt || '—'}
                    </td>
                    <td className="px-4 py-3">
                      {s.status === 'in-progress' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onStatusChange(s.sessionId, 'completed')}
                          title="Mark as completed"
                        >
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onStatusChange(s.sessionId, 'in-progress')}
                          title="Reopen"
                        >
                          <RotateCcw className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <span className="text-sm text-muted-foreground">
              Page {page + 1} of {pageCount}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page === pageCount - 1} onClick={() => setPage(p => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
