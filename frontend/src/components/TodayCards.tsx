import { Clock, FolderOpen, CheckCircle, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { localDateStr } from '@/lib/utils';
import type { Session, DayStats } from '@/lib/types';

interface Props {
  sessions: Session[];
  dailyStats: DayStats[];
}

export function TodayCards({ sessions, dailyStats }: Props) {
  const today = localDateStr();

  // Sessions that had any message activity today (not just sessions that started today)
  const todaySessions = sessions.filter(s => s.activeDates?.includes(today));

  // Hours come from daily-stats (via App, so they refresh on the same timer as
  // everything else) — that's what keeps this card in step with the bar chart.
  const todayHours = dailyStats.find(d => d.date === today)?.hours ?? 0;

  const uniqueProjects = new Set(todaySessions.map(s => s.project)).size;
  const completed = todaySessions.filter(s => s.status === 'completed').length;

  const formatHours = (h: number) => {
    if (h < 1) return `${Math.round(h * 60)}m`;
    return `${h.toFixed(1)}h`;
  };

  const cards = [
    {
      title: 'Hours Today',
      value: formatHours(todayHours),
      description: `across ${todaySessions.length} session${todaySessions.length !== 1 ? 's' : ''}`,
      icon: Clock,
    },
    {
      title: 'Projects Touched',
      value: uniqueProjects,
      description: 'distinct codebases',
      icon: FolderOpen,
    },
    {
      title: 'Sessions',
      value: todaySessions.length,
      description: 'Claude conversations',
      icon: Activity,
    },
    {
      title: 'Completed',
      value: `${completed}/${todaySessions.length}`,
      description: 'tasks marked done',
      icon: CheckCircle,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map(card => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{card.value}</div>
            <p className="text-xs text-muted-foreground">{card.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
