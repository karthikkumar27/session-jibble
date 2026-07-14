import { useEffect, useState } from 'react';
import { Clock, FolderOpen, CheckCircle, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { localDateStr } from '@/lib/utils';
import type { Session } from '@/lib/types';

interface Props {
  sessions: Session[];
}

export function TodayCards({ sessions }: Props) {
  const today = localDateStr();

  // Sessions that had any message activity today (not just sessions that started today)
  const todaySessions = sessions.filter(s => s.activeDates?.includes(today));

  // Hours: fetch from daily-stats so it matches the bar chart exactly
  const [todayHours, setTodayHours] = useState<number | null>(null);
  useEffect(() => {
    fetch('/api/daily-stats')
      .then(r => r.json())
      .then((data: { date: string; hours: number }[]) => {
        const entry = data.find(d => d.date === localDateStr());
        setTodayHours(entry?.hours ?? 0);
      })
      .catch(() => setTodayHours(null));
  }, [today]);

  const uniqueProjects = new Set(todaySessions.map(s => s.project)).size;
  const completed = todaySessions.filter(s => s.status === 'completed').length;

  const formatHours = (h: number) => {
    if (h < 1) return `${Math.round(h * 60)}m`;
    return `${h.toFixed(1)}h`;
  };

  const cards = [
    {
      title: 'Hours Today',
      value: todayHours === null ? '…' : formatHours(todayHours),
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
