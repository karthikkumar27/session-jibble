import { useMemo, useState } from 'react';
import { CheckCircle2, RotateCcw, CalendarRange, X, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { localDateStr, formatDateLabel } from '@/lib/utils';
import { buildExportPayload, downloadJson, exportFilename } from '@/lib/exportJson';
import type { Session, SessionDay, CategoryFilterValue } from '@/lib/types';

interface Props {
  sessions: Session[];
  selectedDates: string[];
  category: CategoryFilterValue;
  onClearFilter: () => void;
  onStatusChange: (sessionId: string, status: 'completed' | 'in-progress') => void;
}

// What actually gets rendered as a table row. Unfiltered this is one per session;
// filtered it is one per session-per-day.
interface DisplayRow {
  key: string;
  date: string;
  hours: number;
  minutes: number;
  session: Session;
}

const PAGE_SIZE = 20;

// Durations are inferred from message-timestamp gaps, so minute-level precision
// is false precision. Snap to the nearest 5 min, with a floor of 5 so a short
// but real session never rounds down to 0m.
const roundToFive = (minutes: number) => Math.max(5, Math.round(minutes / 5) * 5);

const formatDuration = (hours: number, minutes: number) => {
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  if (minutes > 0) {
    const rounded = roundToFive(minutes);
    // 58m rounds to 60m — show it in the hours format the rest of the column uses.
    return rounded >= 60 ? '1.0h' : `${rounded}m`;
  }
  return '<1m';
};

export function SessionsTable({ sessions, selectedDates, category, onClearFilter, onStatusChange }: Props) {
  const [page, setPage] = useState(0);
  const today = localDateStr();
  const isFiltered = selectedDates.length > 0;

  // Category narrows the pool first; the date filter then applies to what remains,
  // so the two compose rather than fighting.
  const scoped = useMemo(
    () => (category === 'all' ? sessions : sessions.filter(s => s.category === category)),
    [sessions, category]
  );

  // One entry per (session, selected day) pair. Hours are that day's slice —
  // never summed across days, so a session spanning three selected days appears
  // three times rather than as one inflated total.
  const sessionDays = useMemo<SessionDay[]>(() => {
    if (!isFiltered) return [];
    const wanted = new Set(selectedDates);
    const rows: SessionDay[] = [];
    for (const session of scoped) {
      for (const date of session.activeDates ?? []) {
        if (wanted.has(date)) {
          rows.push({ date, hours: session.dailyActive?.[date] ?? 0, session });
        }
      }
    }
    rows.sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.hours - a.hours ||
        a.session.project.localeCompare(b.session.project)
    );
    return rows;
  }, [scoped, selectedDates, isFiltered]);

  const displayRows = useMemo<DisplayRow[]>(() => {
    if (isFiltered) {
      return sessionDays.map(r => ({
        key: `${r.session.sessionId}-${r.date}`,
        date: r.date,
        hours: r.hours,
        minutes: Math.round(r.hours * 60),
        session: r.session,
      }));
    }
    return scoped.map(s => ({
      key: s.sessionId,
      date: s.lastActiveDate,
      hours: s.durationHours,
      minutes: s.durationMinutes,
      session: s,
    }));
  }, [isFiltered, sessionDays, scoped]);

  // Jump back to page 1 whenever the selection changes — otherwise filtering
  // while on page 3 leaves you deep in (or past the end of) the results.
  // Adjusting state during render rather than in an effect.
  const selectionKey = `${category}|${selectedDates.join(',')}`;
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (prevSelectionKey !== selectionKey) {
    setPrevSelectionKey(selectionKey);
    setPage(0);
  }

  const pageCount = Math.max(1, Math.ceil(displayRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1); // guard against the list shrinking
  const visible = displayRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const firstDate = selectedDates[0];
  const lastDate = selectedDates[selectedDates.length - 1];

  const title = !isFiltered
    ? 'All Sessions'
    : selectedDates.length === 1
      ? `Sessions on ${formatDateLabel(firstDate)}`
      : `Sessions from ${formatDateLabel(firstDate)} to ${formatDateLabel(lastDate)}`;

  const description = isFiltered
    ? `${sessionDays.length} session-day${sessionDays.length === 1 ? '' : 's'} across ${selectedDates.length} day${selectedDates.length === 1 ? '' : 's'} · each row shows that day's hours only`
    : `${scoped.length} sessions total · sorted by most recent activity`;

  const handleExport = () => {
    downloadJson(buildExportPayload(selectedDates, sessionDays, category), exportFilename(selectedDates));
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {isFiltered && (
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Download className="h-3.5 w-3.5 mr-1" />
                Export JSON
              </Button>
              <Button variant="outline" size="sm" onClick={onClearFilter}>
                <X className="h-3.5 w-3.5 mr-1" />
                Clear
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {displayRows.length === 0 ? (
          <div className="px-6 pb-6 text-sm text-muted-foreground">
            No sessions were active on the selected {selectedDates.length === 1 ? 'day' : 'days'}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    {isFiltered ? 'Date' : 'Last Active'}
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Project</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Duration</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Excerpt</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row, i) => {
                  const s = row.session;
                  const isToday = row.date === today;
                  const spansMultipleDays = s.activeDates.length > 1;
                  return (
                    <tr
                      key={row.key}
                      className={`border-b transition-colors hover:bg-muted/30 ${
                        isToday ? 'bg-blue-50/40' : i % 2 === 0 ? '' : 'bg-muted/10'
                      }`}
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={isToday ? 'font-semibold text-blue-700' : 'text-muted-foreground'}>
                          {row.date}
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
                        {formatDuration(row.hours, row.minutes)}
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
                            title="Mark as completed (applies to the whole session)"
                          >
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onStatusChange(s.sessionId, 'in-progress')}
                            title="Reopen (applies to the whole session)"
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
        )}
        {pageCount > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <span className="text-sm text-muted-foreground">
              Page {safePage + 1} of {pageCount}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={safePage === pageCount - 1} onClick={() => setPage(safePage + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
