import { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { TodayCards } from '@/components/TodayCards';
import { TodayWork } from '@/components/TodayWork';
import { HoursChart } from '@/components/HoursChart';
import { SessionsTable } from '@/components/SessionsTable';
import { Button } from '@/components/ui/button';
import type { Session, DayStats } from '@/lib/types';

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  // Daily stats live here rather than inside HoursChart/TodayCards so both read
  // the same payload and both get refreshed on the same timer.
  const [dailyStats, setDailyStats] = useState<DayStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  // Days selected in HoursChart — one from a click, several from a drag.
  // Empty = no filter, show all sessions.
  const [selectedDates, setSelectedDates] = useState<string[]>([]);

  const fetchData = useCallback(async () => {
    setRefreshing(true);
    try {
      setError(null);
      const [statsRes, dailyRes] = await Promise.all([
        fetch('/api/stats'),
        fetch('/api/daily-stats'),
      ]);
      if (!statsRes.ok) throw new Error(`API error: ${statsRes.status}`);
      if (!dailyRes.ok) throw new Error(`API error: ${dailyRes.status}`);
      const [statsData, dailyData] = await Promise.all([statsRes.json(), dailyRes.json()]);
      setSessions(statsData);
      setDailyStats(dailyData);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 120_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleStatusChange = async (sessionId: string, status: 'completed' | 'in-progress') => {
    const endpoint = status === 'completed' ? 'done' : 'reopen';
    await fetch(`/api/sessions/${sessionId}/${endpoint}`, { method: 'POST' });
    setSessions(prev =>
      prev.map(s => (s.sessionId === sessionId ? { ...s, status } : s))
    );
  };

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b">
        <div className="flex h-16 items-center px-6 gap-4">
          <span className="text-lg font-semibold">Claude Session Tracker</span>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{today}</span>
            <Button variant="outline" size="sm" onClick={fetchData} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error} — is the backend running on :8089?
          </div>
        )}

        <div>
          <h2 className="text-lg font-semibold mb-3">What I Worked On Today</h2>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : (
            <TodayWork sessions={sessions} />
          )}
        </div>

        {!loading && <TodayCards sessions={sessions} dailyStats={dailyStats} />}
        {!loading && (
          <HoursChart
            dailyStats={dailyStats}
            selectedDates={selectedDates}
            onSelectDates={setSelectedDates}
          />
        )}
        {!loading && sessions.length > 0 && (
          <SessionsTable
            sessions={sessions}
            selectedDates={selectedDates}
            onClearFilter={() => setSelectedDates([])}
            onStatusChange={handleStatusChange}
          />
        )}

        <div className="text-xs text-muted-foreground text-center pb-4">
          Last refreshed {lastRefresh.toLocaleTimeString()} · auto-refreshes every 2 min
        </div>
      </div>
    </div>
  );
}
