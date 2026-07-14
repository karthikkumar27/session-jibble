import { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { TodayCards } from '@/components/TodayCards';
import { TodayWork } from '@/components/TodayWork';
import { HoursChart } from '@/components/HoursChart';
import { SessionsTable } from '@/components/SessionsTable';
import { Button } from '@/components/ui/button';
import type { Session } from '@/lib/types';

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const fetchSessions = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/stats');
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      setSessions(data);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 120_000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

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
            <Button variant="outline" size="sm" onClick={fetchSessions} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
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

        {!loading && <TodayCards sessions={sessions} />}
        {!loading && <HoursChart />}
        {!loading && sessions.length > 0 && (
          <SessionsTable sessions={sessions} onStatusChange={handleStatusChange} />
        )}

        <div className="text-xs text-muted-foreground text-center pb-4">
          Last refreshed {lastRefresh.toLocaleTimeString()} · auto-refreshes every 2 min
        </div>
      </div>
    </div>
  );
}
