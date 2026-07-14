import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { localDateStr } from '@/lib/utils';

interface DayPoint {
  date: string;
  label: string;
  hours: number;
}

export function HoursChart() {
  const [data, setData] = useState<DayPoint[]>([]);

  useEffect(() => {
    fetch('/api/daily-stats')
      .then(r => r.json())
      .then((raw: { date: string; hours: number }[]) => {
        const byDate: Record<string, number> = {};
        for (const r of raw) byDate[r.date] = r.hours;

        const days: DayPoint[] = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const date = localDateStr(d);   // local date, not UTC
          const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          days.push({ date, label, hours: parseFloat((byDate[date] ?? 0).toFixed(1)) });
        }
        setData(days);
      })
      .catch(() => {});
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hours per Day</CardTitle>
        <CardDescription>Active work time, last 30 days (idle gaps &gt;30 min excluded)</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11 }}
              interval={4}
            />
            <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
            <Tooltip
              cursor={{ fill: 'hsl(210 40% 96.1%)' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div className="rounded-lg border bg-background p-2 shadow text-sm">
                    <p className="font-medium">{label}</p>
                    <p className="text-muted-foreground">{payload[0].value}h active</p>
                  </div>
                );
              }}
            />
            <Bar dataKey="hours" fill="hsl(222.2 47.4% 11.2%)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
