import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Settings } from 'lucide-react';
import { TodayCards } from '@/components/TodayCards';
import { TodayWork } from '@/components/TodayWork';
import { HoursChart } from '@/components/HoursChart';
import { SessionsTable } from '@/components/SessionsTable';
import { CategoryFilter } from '@/components/CategoryFilter';
import { SettingsPanel } from '@/components/SettingsPanel';
import { Button } from '@/components/ui/button';
import type {
  Session, DayStats, CategoryFilterValue, CategoryConfig, ConfigResponse, ProjectRow,
} from '@/lib/types';

const VALID_CATEGORIES: CategoryFilterValue[] = ['all', 'work', 'nonWork', 'uncategorized'];

// An unrecognised token falls back to 'all' rather than erroring.
function categoryFromUrl(): CategoryFilterValue {
  const raw = new URLSearchParams(window.location.search).get('category');
  return VALID_CATEGORIES.includes(raw as CategoryFilterValue)
    ? (raw as CategoryFilterValue)
    : 'all';
}

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
  const [category, setCategory] = useState<CategoryFilterValue>(categoryFromUrl);
  const [config, setConfig] = useState<CategoryConfig | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setRefreshing(true);
    try {
      setError(null);
      const [statsRes, dailyRes, configRes, projectsRes] = await Promise.all([
        fetch('/api/stats'),
        fetch('/api/daily-stats'),
        fetch('/api/config'),
        fetch('/api/projects'),
      ]);
      if (!statsRes.ok) throw new Error(`API error: ${statsRes.status}`);
      if (!dailyRes.ok) throw new Error(`API error: ${dailyRes.status}`);
      const [statsData, dailyData, configData, projectData] = await Promise.all([
        statsRes.json(), dailyRes.json(), configRes.json(), projectsRes.json(),
      ]);
      setSessions(statsData);
      setDailyStats(dailyData);
      setConfig((configData as ConfigResponse).config);
      setUnconfigured((configData as ConfigResponse).unconfigured);
      setConfigError((configData as ConfigResponse).error);
      setProjects(projectData as ProjectRow[]);
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

  // Mirror the filter into the URL so a filtered view can be shared or reloaded.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (category === 'all') url.searchParams.delete('category');
    else url.searchParams.set('category', category);
    window.history.replaceState({}, '', url);
  }, [category]);

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

  const uncategorizedCount = projects.filter(p => p.category === 'uncategorized').length;

  // The Uncategorized segment disappears when its count hits zero — via the URL
  // (?category=uncategorized with nothing uncategorized), or by assigning the last
  // uncategorized folder in Settings. Without this reset the dashboard would keep
  // filtering to a category that has no visible control: an empty chart with no
  // segment highlighted and no way to tell why.
  const effectiveCategory: CategoryFilterValue =
    category === 'uncategorized' && uncategorizedCount === 0 ? 'all' : category;

  const handleConfigSaved = (saved: CategoryConfig) => {
    setConfig(saved);
    setUnconfigured(false);
    fetchData();
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b">
        <div className="flex h-16 items-center px-6 gap-4">
          <span className="text-lg font-semibold">Claude Session Tracker</span>
          <div className="ml-auto flex items-center gap-3">
            {!unconfigured && (
              <CategoryFilter
                value={effectiveCategory}
                onChange={setCategory}
                uncategorizedCount={uncategorizedCount}
              />
            )}
            <span className="text-sm text-muted-foreground">{today}</span>
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4 mr-1" />
              Settings
            </Button>
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

        {configError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {configError}
          </div>
        )}

        {unconfigured && !loading && (
          <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-4 py-3 text-sm">
            <span className="flex-1">
              No categories set up yet — tell the dashboard which folders are work
              and which aren't.
            </span>
            <Button size="sm" onClick={() => setSettingsOpen(true)}>Set up categories</Button>
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

        {!loading && <TodayCards sessions={sessions} dailyStats={dailyStats} category={effectiveCategory} />}
        {!loading && (
          <HoursChart
            dailyStats={dailyStats}
            selectedDates={selectedDates}
            onSelectDates={setSelectedDates}
            category={effectiveCategory}
          />
        )}
        {!loading && sessions.length > 0 && (
          <SessionsTable
            sessions={sessions}
            selectedDates={selectedDates}
            category={effectiveCategory}
            onClearFilter={() => setSelectedDates([])}
            onStatusChange={handleStatusChange}
          />
        )}

        <div className="text-xs text-muted-foreground text-center pb-4">
          Last refreshed {lastRefresh.toLocaleTimeString()} · auto-refreshes every 2 min
        </div>
      </div>

      {config && (
        <SettingsPanel
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          config={config}
          projects={projects}
          onSaved={handleConfigSaved}
        />
      )}
    </div>
  );
}
