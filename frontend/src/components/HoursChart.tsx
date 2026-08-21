import { useMemo, useRef, useState } from 'react';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { localDateStr } from '@/lib/utils';
import { CATEGORY_LABELS } from '@/lib/types';
import type { DayStats, CategoryFilterValue } from '@/lib/types';

interface DayPoint {
  date: string;
  label: string;
  hours: number;
}

interface Props {
  dailyStats: DayStats[];
  selectedDates: string[];
  onSelectDates: (dates: string[]) => void;
  category: CategoryFilterValue;
}

// All and Work keep the existing near-black primary; the other two are distinct
// hues, each at least 4.5:1 against the card background.
const BAR_FILL = 'hsl(222.2 47.4% 11.2%)';
const FILL_BY_CATEGORY: Record<CategoryFilterValue, string> = {
  all: BAR_FILL,
  work: BAR_FILL,
  nonWork: 'hsl(262 60% 48%)',
  uncategorized: 'hsl(215 20% 45%)',
};
const FIELD_BY_CATEGORY: Record<CategoryFilterValue, keyof DayStats> = {
  all: 'hours',
  work: 'workHours',
  nonWork: 'nonWorkHours',
  uncategorized: 'uncategorizedHours',
};

export function HoursChart({ dailyStats, selectedDates, onSelectDates, category }: Props) {
  // Column indices captured during a press/drag; null when idle.
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Build a complete 30-day window client-side and join the API data onto it,
  // so days with no recorded activity still render (and stay selectable).
  const data = useMemo<DayPoint[]>(() => {
    const field = FIELD_BY_CATEGORY[category];
    const byDate: Record<string, number> = {};
    for (const r of dailyStats) byDate[r.date] = (r[field] as number) ?? 0;

    const days: DayPoint[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = localDateStr(d); // local date, not UTC
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      days.push({ date, label, hours: parseFloat((byDate[date] ?? 0).toFixed(1)) });
    }
    return days;
  }, [dailyStats, category]);

  const dragLo = dragStart !== null && dragEnd !== null ? Math.min(dragStart, dragEnd) : null;
  const dragHi = dragStart !== null && dragEnd !== null ? Math.max(dragStart, dragEnd) : null;
  const isDragging = dragLo !== null && dragHi !== null && dragLo !== dragHi;

  // While dragging, preview the range live instead of the committed selection.
  const highlighted = useMemo(() => {
    if (dragLo !== null && dragHi !== null) {
      return new Set(data.slice(dragLo, dragHi + 1).map(d => d.date));
    }
    return new Set(selectedDates);
  }, [data, dragLo, dragHi, selectedDates]);

  const hasSelection = highlighted.size > 0;

  // Which column is under this X? Derived from the plot area's own geometry
  // rather than Recharts' activeIndex, which is only populated while a tooltip
  // is active (i.e. mid-hover) and is null for the first press of a gesture.
  // The grid <g> spans exactly the plot area, and a band scale divides it into
  // data.length equal columns — so this is a plain proportion.
  const indexFromClientX = (clientX: number): number | null => {
    const grid = containerRef.current?.querySelector('.recharts-cartesian-grid');
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const index = Math.floor(((clientX - rect.left) / rect.width) * data.length);
    // Clamp so dragging past either edge extends to that end rather than aborting
    return Math.min(data.length - 1, Math.max(0, index));
  };

  const toggleSingle = (index: number) => {
    const point = data[index];
    if (!point) return;
    const isOnlySelection = selectedDates.length === 1 && selectedDates[0] === point.date;
    onSelectDates(isOnlySelection ? [] : [point.date]);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const index = indexFromClientX(e.clientX);
    if (index === null) return;
    // Capture so a drag that wanders outside the chart still delivers move/up
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragStart(index);
    setDragEnd(index);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart === null) return;
    const index = indexFromClientX(e.clientX);
    if (index !== null && index !== dragEnd) setDragEnd(index);
  };

  // A press that never left its starting column is a click; anything wider is a
  // range. One code path, so there is no click/drag double-handling to guard.
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart;
    // Recompute from where the pointer was actually released rather than trusting
    // the last sampled move — the range is press-point to release-point, however
    // sparsely the moves in between happened to fire.
    const end = indexFromClientX(e.clientX) ?? dragEnd;
    setDragStart(null);
    setDragEnd(null);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (start === null || end === null) return;

    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    if (lo === hi) {
      toggleSingle(lo);
      return;
    }
    onSelectDates(data.slice(lo, hi + 1).map(d => d.date));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Hours per Day{category !== 'all' ? ` · ${CATEGORY_LABELS[category]}` : ''}
        </CardTitle>
        <CardDescription>
          Active work time, last 30 days (idle gaps &gt;30 min excluded) · click a day, or drag
          across several, to filter the session list
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          // userSelect: dragging would otherwise smear a text selection across the
          // page. touchAction: let the chart own horizontal drags on touch devices
          // instead of the browser scrolling.
          style={{ cursor: 'pointer', userSelect: 'none', touchAction: 'none' }}
        >
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
                const point = payload[0].payload as DayPoint;
                const isSelected = selectedDates.includes(point.date);
                return (
                  <div className="rounded-lg border bg-background p-2 shadow text-sm">
                    <p className="font-medium">{label}</p>
                    <p className="text-muted-foreground">{payload[0].value}h active</p>
                    <p className="text-xs text-muted-foreground">
                      {isDragging
                        ? 'Release to filter these days'
                        : isSelected
                          ? 'Click to clear filter'
                          : 'Click to filter · drag to select a range'}
                    </p>
                  </div>
                );
              }}
            />
            {isDragging && dragLo !== null && dragHi !== null && (
              <ReferenceArea
                x1={data[dragLo].label}
                x2={data[dragHi].label}
                strokeOpacity={0}
                fill={FILL_BY_CATEGORY[category]}
                fillOpacity={0.08}
              />
            )}
            {/* No onClick here — the wrapper's pointer handlers own selection, so
                days with zero hours (and zero bar height) are still selectable. */}
            <Bar dataKey="hours" radius={[3, 3, 0, 0]}>
              {data.map(d => (
                <Cell
                  key={d.date}
                  fill={FILL_BY_CATEGORY[category]}
                  // Dim everything outside the selection (or the live drag range)
                  fillOpacity={hasSelection && !highlighted.has(d.date) ? 0.2 : 1}
                />
              ))}
            </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
