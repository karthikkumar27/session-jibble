import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronLeft, ChevronRight, Loader2, Lock } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type { ProjectOption, TimesheetEntry, WeekResponse } from '@/lib/types';
import { localDateStr } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SubmitState = 'idle' | 'submitting' | 'done' | 'error';

// Must stay byte-identical to entryKey() in backend/lib/sphere360/merge.js:
// this set decides which filed rows are shown as superseded, and the server's
// copy decides which are actually replaced. JSON.stringify, not join('|'), so an
// id containing the separator cannot alias a different triple — a false match
// here DELETES a filed row.
const entryKey = (e: TimesheetEntry) =>
  JSON.stringify([e.workDate, e.projectId ?? '', e.activityId]);

const shiftWeek = (monday: string, weeks: number) => {
  const [y, m, d] = monday.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + weeks * 7 * 86_400_000;
  const dt = new Date(ms);
  // UTC getters against a UTC-built instant: a calendar label, never a local shift.
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

// Splits by hand and builds a LOCAL date, exactly as formatDateLabel() in
// lib/utils.ts does: new Date('2026-07-20') parses as UTC midnight and renders
// as the previous day east of UTC.
const dayLabel = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
};

export function TimesheetWeek({ open, onOpenChange }: Props) {
  const [anchor, setAnchor] = useState<string>(() => localDateStr(new Date()));
  const [data, setData] = useState<WeekResponse | null>(null);
  // No `loading` boolean state: setting one to true would be a setState call
  // that fires synchronously (before any await) whenever the effect below
  // invokes `load`, which is exactly the react-hooks/set-state-in-effect shape
  // App.tsx already carries as the one accepted baseline error — this component
  // must not add a second one. Instead, `loading` is derived at render time by
  // comparing `anchor` against the anchor the current `data` was loaded for;
  // `loadedAnchor` is only ever written from inside `load`, after its await.
  const [loadedAnchor, setLoadedAnchor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, TimesheetEntry>>({});
  const [submit, setSubmit] = useState<SubmitState>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Monotonic request id. A response is applied only if it belongs to the most
  // recent request: a late reply for an older week must never overwrite a newer
  // one, because the header would silently flip back while Confirm stayed live.
  const latestRequest = useRef(0);

  // Promise-chained rather than async/await + try/catch: a JS `catch` clause
  // inside an async function is reachable synchronously (before the effect's
  // call to `load` returns) if the code ahead of the first `await` throws
  // synchronously, which is exactly the react-hooks/set-state-in-effect shape
  // this file must not reintroduce. `.then`/`.catch`/`.finally` callbacks are
  // guaranteed by the Promise spec to run as microtasks, never synchronously,
  // regardless of when the underlying promise settles — so this form carries
  // the same error handling with no synchronous path back into the effect.
  const load = useCallback((date: string) => {
    const seq = ++latestRequest.current;
    return fetch(`/api/sphere360/week?date=${date}`)
      .then(res => {
        // A response is applied only if it belongs to the most recent
        // request: a late reply for an older week must never overwrite a
        // newer one, because the header would silently flip back while
        // Confirm stayed live.
        if (seq !== latestRequest.current) return;
        if (!res.ok) {
          setLoadError(`Could not load the week (HTTP ${res.status})`);
          setData(null);
          return;
        }
        return res.json().then((body: WeekResponse) => {
          if (seq !== latestRequest.current) return;
          setLoadError(null);
          setData(body);
          // Seed the editable copy from the server's draft on every load, so
          // switching weeks never carries another week's edits across.
          const seeded: Record<string, TimesheetEntry> = {};
          for (const e of body.drafted) seeded[entryKey(e)] = { ...e };
          setEdits(seeded);
          setSubmit('idle');
          setSubmitError(null);
        });
      })
      .catch((err: unknown) => {
        if (seq !== latestRequest.current) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load the week');
        setData(null);
      })
      .finally(() => {
        if (seq === latestRequest.current) setLoadedAnchor(date);
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    // Async loader: every setState lands after an await, which keeps this clear
    // of react-hooks/set-state-in-effect. Do not hoist the call out of the effect,
    // and do not add a synchronous setState (e.g. a `loading` flag) ahead of it.
    void load(anchor);
  }, [open, anchor, load]);

  const loading = open && loadedAnchor !== anchor;
  const drafted = Object.values(edits);

  // Derived from the LIVE rows, never from data.replacedKeys — that field is the
  // server's snapshot of the ORIGINAL draft, and the attribution <select> changes
  // a row's projectId/activityId and therefore its key. Re-attribute a drafted
  // row onto a filed row's key and the stale set would leave that filed row
  // un-struck and its hours in the day total, while the server's merge replaces
  // it: a row this app did not author destroyed silently, under a total the
  // operator confirmed. The server still sends replacedKeys; the UI ignores it.
  const replaced = new Set(drafted.map(entryKey));

  const dayTotal = (date: string) => {
    if (!data) return 0;
    const filed = data.filed
      .filter(e => e.workDate === date && !replaced.has(entryKey(e)))
      .reduce((s, e) => s + (Number(e.hours) || 0), 0);
    const mine = drafted.filter(e => e.workDate === date).reduce((s, e) => s + (Number(e.hours) || 0), 0);
    return parseFloat((filed + mine).toFixed(2));
  };

  // A week already submitted or approved is not ours to replace: the POST
  // endpoint carries the whole week, so filing into one would reopen or corrupt
  // a record someone signed off. The server refuses it with a 409 regardless —
  // this only stops the operator sending a request that cannot succeed. No
  // condition on shortBy or day totals belongs here: a short day is a prompt to
  // look, not a reason to block filing.
  const weekWritable = !data?.week || data.week.writable;

  const canConfirm =
    !!data && data.mappingConfigured && !data.fetchError && !loading && !loadError && weekWritable &&
    drafted.length > 0 && drafted.every(e => e.projectId && e.activityId && Number(e.hours) > 0);

  const confirm = async () => {
    if (!data) return;
    setSubmit('submitting');
    setSubmitError(null);
    try {
      const res = await fetch('/api/sphere360/week', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: data.monday, entries: drafted }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setSubmitError(body.error || `HTTP ${res.status}`);
        setSubmit('error');
        return;
      }
      setSubmit('done');
      await load(anchor);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Request failed');
      setSubmit('error');
    }
  };

  // Recomputed from dayTotal(), not from data.byDay: the server's figures are a
  // snapshot from load time, and the day rows below already track live edits. A
  // footer reading server state would contradict the rows the moment an hours
  // field is touched.
  const weekLogged = data
    ? parseFloat(data.dates.reduce((s, d) => s + dayTotal(d), 0).toFixed(2))
    : 0;
  // Only obligated days carry a floor: a week with one holiday is a 4-day
  // floor, not the flat 5 the constant used to assume. Counted from byDay's
  // own isWorkday, which already folds in both weekends and holidays, rather
  // than re-deriving either rule here.
  const weekFloor = data
    ? parseFloat((data.byDay.filter(d => d.isWorkday).length * data.dailyMinimumHours).toFixed(2))
    : 0;
  const weekShort = parseFloat(Math.max(0, weekFloor - weekLogged).toFixed(2));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-3xl">
        <SheetTitle>Sphere360 timesheet</SheetTitle>
        <SheetDescription>
          Drafts this week's coding rows. Meetings and other work stay yours to add.
        </SheetDescription>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAnchor(shiftWeek(data?.monday ?? anchor, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium">
            {data ? `Week of ${dayLabel(data.monday)}` : '…'}
          </span>
          <Button variant="outline" size="sm" onClick={() => setAnchor(shiftWeek(data?.monday ?? anchor, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>

        {loadError && (
          <div className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {data?.fetchError && (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>{data.fetchError.message}</span>
          </div>
        )}

        {data?.week && !data.week.writable && (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <Lock className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              Sphere360 has this week as{' '}
              <strong>{data.week.status ?? 'an unrecognised status'}</strong> and not unlocked, so it
              cannot be filed from here. Unlock or reopen it in Sphere360 first.
            </span>
          </div>
        )}

        {data && !data.mappingConfigured && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            No timesheet mapping yet. Add your resourceId and project roots to{' '}
            <code>~/.claude/session-jibble.timesheet.json</code> before drafting.
          </div>
        )}

        {data?.dates.map(date => {
          const filedRows = data.filed.filter(e => e.workDate === date);
          // Object.entries, not drafted.filter: the handlers below must address
          // `edits` by the key it is actually stored under. Re-deriving the key
          // from an edited row leaves prev[key] undefined after the first
          // re-attribution, which writes a ghost entry with no workDate and
          // freezes hours, comments and Confirm.
          const myRows = Object.entries(edits).filter(([, e]) => e.workDate === date);
          const total = dayTotal(date);
          const dayInfo = data.byDay.find(d => d.date === date);
          const isWorkday = dayInfo?.isWorkday ?? true;
          const isHoliday = dayInfo?.isHoliday ?? false;
          const short = isWorkday
            ? parseFloat(Math.max(0, data.dailyMinimumHours - total).toFixed(2))
            : 0;

          return (
            <div key={date} className="rounded-lg border p-3">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{dayLabel(date)}</span>
                {/* Only an obligated day names a minimum. A holiday is labelled
                    instead — "minimum 8h" on a gazetted day off would be
                    misleading, not just unmet. A weekend that is not also a
                    holiday shows neither: it already carries no obligation. */}
                <span className="text-xs text-muted-foreground">
                  {isHoliday ? 'holiday' : isWorkday ? `minimum ${data.dailyMinimumHours}h` : null}
                </span>
              </div>

              {filedRows.length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="text-xs uppercase text-muted-foreground">already filed</div>
                  {filedRows.map((e, i) => (
                    <div
                      key={`${entryKey(e)}-${i}`}
                      className={`flex justify-between text-sm ${
                        replaced.has(entryKey(e)) ? 'text-muted-foreground line-through' : ''
                      }`}
                    >
                      {/* Filed rows are Sphere360's, not ours: a null comment or a
                          string hours field would throw during render and blank the
                          whole dashboard — there is no error boundary. */}
                      <span className="truncate pr-2">{(e.comments ?? '').split('\n')[0] || '(no comment)'}</span>
                      <span className="tabular-nums">{(Number(e.hours) || 0).toFixed(2)} h</span>
                    </div>
                  ))}
                </div>
              )}

              {myRows.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="text-xs uppercase text-muted-foreground">
                    drafted from session-jibble
                    <span className="ml-2 rounded bg-amber-100 px-1 text-amber-800 normal-case">
                      ⚠ uncorrected
                    </span>
                  </div>
                  {myRows.map(([key, e]) => (
                    <div key={key} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <select
                          className="rounded border px-2 py-1 text-sm"
                          value={data.projects.findIndex(
                            p => p.projectId === e.projectId && p.activityId === e.activityId
                          )}
                          onChange={ev => {
                            const picked = data.projects[Number(ev.target.value)];
                            if (!picked) return;
                            setEdits(prev => ({
                              ...prev,
                              [key]: { ...prev[key], projectId: picked.projectId, activityId: picked.activityId },
                            }));
                          }}
                        >
                          {data.projects.map((p: ProjectOption, i: number) => (
                            <option key={`${p.projectId}-${p.activityId}`} value={i}>{p.label}</option>
                          ))}
                        </select>
                        <input
                          className="w-20 rounded border px-2 py-1 text-sm tabular-nums"
                          type="number" step="0.01" min="0" max="24"
                          value={e.hours}
                          onChange={ev => setEdits(prev => ({
                            ...prev,
                            [key]: { ...prev[key], hours: parseFloat(ev.target.value) || 0 },
                          }))}
                        />
                        <span className="text-xs text-muted-foreground">hours</span>
                      </div>
                      <textarea
                        className="w-full rounded border px-2 py-1 text-sm"
                        rows={2}
                        value={e.comments}
                        onChange={ev => setEdits(prev => ({
                          ...prev,
                          [key]: { ...prev[key], comments: ev.target.value },
                        }))}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 flex justify-between border-t pt-2 text-sm">
                <span>day total</span>
                <span className="tabular-nums">
                  {total.toFixed(2)} h{' '}
                  {short > 0
                    ? <span className="text-amber-700">⚠ {short.toFixed(2)} h below minimum</span>
                    : <span className="text-emerald-700">✓</span>}
                </span>
              </div>
            </div>
          );
        })}

        {data && data.unmapped.length > 0 && (
          <div className="rounded-md border p-3 text-sm">
            <div className="text-xs uppercase text-muted-foreground">not included</div>
            {data.unmapped.map(u => (
              <div key={u.projectPath} className="flex justify-between">
                <span className="truncate pr-2">{u.projectPath}</span>
                <span className="tabular-nums">{u.hours.toFixed(2)} h (unmapped)</span>
              </div>
            ))}
          </div>
        )}

        {data && (
          <div className="text-sm text-muted-foreground">
            {weekLogged.toFixed(2)} h logged
            {weekShort > 0 && ` · ${weekShort.toFixed(2)} h below the ${weekFloor.toFixed(0)} h floor`}
          </div>
        )}

        {submitError && (
          <div className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}

        <Button onClick={confirm} disabled={!canConfirm || submit === 'submitting'}>
          {submit === 'submitting' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submit === 'done' && <Check className="mr-2 h-4 w-4" />}
          {submit === 'done' ? 'Filed' : `Confirm and file ${drafted.length} row${drafted.length === 1 ? '' : 's'}`}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
