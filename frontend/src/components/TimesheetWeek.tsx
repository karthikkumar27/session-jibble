import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronLeft, ChevronRight, Loader2, Lock } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type { CycleResponse, ProjectOption, TimesheetEntry, WeekResponse } from '@/lib/types';
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

// The cutover date, stated once in the header. Split by hand and built LOCAL
// for the same reason dayLabel is: new Date('2026-08-27') parses as UTC
// midnight and renders as the previous day east of UTC — which would print a
// boundary one day off the one actually enforced.
const cutoverLabel = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
};

// Sphere360 renders hours as "13h" and "134h 24m" — the minutes are dropped
// when they are zero, never shown as "13h 0m". Minutes are rounded rather than
// truncated so 7.999h reads 8h and not "7h 59m".
const formatHours = (hours: number) => {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

// Sphere360's "days" unit: hours over one day's capacity, always 2 decimals
// (its own card writes 1.63 and 16.80, not 1.6 and 16.8).
const formatDays = (days: number) => days.toFixed(2);

// 73 renders "73%", 7.065 renders "7.1%" — matching the card, which shows a
// whole number where it has one rather than a hollow "73.0%".
const formatPercent = (percent: number) =>
  `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;

// The backend and this component ship together but do not RESTART together: a
// dev server that is a commit behind returns a response missing whatever field
// the newest commit added, and an unguarded `data.beforeCutover.find(...)`
// white-screens the whole dashboard. Normalising once, here, is what stops a
// version skew from becoming a crash — guarding each read site individually is
// the same fix applied N times and forgotten on the N+1th field.
function normalizeWeek(body: Partial<WeekResponse> | null): WeekResponse | null {
  if (!body || typeof body !== 'object') return null;
  return {
    monday: body.monday ?? '',
    weekStart: body.weekStart ?? '',
    dates: body.dates ?? [],
    projects: body.projects ?? [],
    filed: body.filed ?? [],
    drafted: body.drafted ?? [],
    replacedKeys: body.replacedKeys ?? [],
    unmapped: body.unmapped ?? [],
    beforeCutover: body.beforeCutover ?? [],
    byDay: body.byDay ?? [],
    syncFrom: body.syncFrom ?? null,
    dailyMinimumHours: body.dailyMinimumHours ?? 8,
    dailyMinimumSource: body.dailyMinimumSource ?? 'config',
    resourceId: body.resourceId ?? '',
    mappingConfigured: body.mappingConfigured ?? false,
    mappingError: body.mappingError ?? null,
    fetchError: body.fetchError ?? null,
    week: body.week ?? null,
  };
}

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
  // The billing cycle the viewed week falls in. Loaded separately from the
  // week: it spans five weeks of Sphere360 data, and the sheet must render
  // with or without it.
  const [progress, setProgress] = useState<CycleResponse | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);

  // Monotonic request id. A response is applied only if it belongs to the most
  // recent request: a late reply for an older week must never overwrite a newer
  // one, because the header would silently flip back while Confirm stayed live.
  const latestRequest = useRef(0);
  // The cycle loader's own guard. Deliberately a second ref rather than a
  // shared one: the two requests complete independently, and one counter would
  // let a returning week response cancel a newer cycle response.
  const latestCycleRequest = useRef(0);

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
        return res.json().then((raw: Partial<WeekResponse>) => {
          if (seq !== latestRequest.current) return;
          const body = normalizeWeek(raw);
          if (!body) {
            setLoadError('The week response could not be read');
            setData(null);
            return;
          }
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

  // A SEPARATE loader, deliberately not folded into load(). That function's
  // .then/.catch/.finally shape and staleness guard are load-bearing — its own
  // comment explains why an async/await rewrite reintroduces the
  // react-hooks/set-state-in-effect error this file must not carry — so this
  // mirrors the shape rather than restructuring it. Same promise-chain form,
  // same staleness rule, its own sequence counter.
  const loadCycle = useCallback((date: string) => {
    const seq = ++latestCycleRequest.current;
    return fetch(`/api/sphere360/cycle?date=${date}`)
      .then(res => {
        if (seq !== latestCycleRequest.current) return;
        if (!res.ok) {
          setProgressError(`Could not load the billing cycle (HTTP ${res.status})`);
          setProgress(null);
          return;
        }
        return res.json().then((body: CycleResponse) => {
          if (seq !== latestCycleRequest.current) return;
          setProgressError(null);
          setProgress(body);
        });
      })
      .catch((err: unknown) => {
        if (seq !== latestCycleRequest.current) return;
        setProgressError(err instanceof Error ? err.message : 'Could not load the billing cycle');
        setProgress(null);
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    // Async loader: every setState lands after an await, which keeps this clear
    // of react-hooks/set-state-in-effect. Do not hoist the call out of the effect,
    // and do not add a synchronous setState (e.g. a `loading` flag) ahead of it.
    void load(anchor);
    // Alongside the week, not after it: the two are independent requests and
    // the card must not wait on the sheet's own load.
    void loadCycle(anchor);
  }, [open, anchor, load, loadCycle]);

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
      // Filing changes BILLED, so the cycle card is stale the moment the POST
      // succeeds.
      void loadCycle(anchor);
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
  // Counted from byDay's own isWorkday rather than a hand-rolled *5, so this
  // stays correct if the server's definition of a working day ever changes —
  // but today isWorkday is plain Mon-Fri and a holiday does NOT reduce it,
  // matching Sphere360's own "MY BILLABLE PROGRESS" working-day count: a live
  // cycle containing two public holidays (Merdeka, Malaysia Day) still
  // counted all 23 Mon-Fri days as working days, not 21.
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

        {/* Stated once, above everything. Without it a day that draws no
            drafted row looks like a measurement that failed rather than a
            boundary deliberately held: the operator's timesheet of record was
            Jibble up to the day before this date, and that period is closed. */}
        {data?.syncFrom && (
          <div className="text-xs text-muted-foreground">
            Syncing from <strong>{cutoverLabel(data.syncFrom)}</strong> — earlier days were kept in
            Jibble and are never drafted or filed from here.
          </div>
        )}

        {/* Sphere360's own "MY BILLABLE PROGRESS" card for the 26th-to-25th
            billing cycle this week falls in, recomputed from the same weeks it
            reads. Rendered above the week navigation because it is the frame
            the week sits inside: whether a given week matters is a question
            about the cycle, not about the week. */}
        {progress && (
          <div className="rounded-lg border p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium uppercase text-muted-foreground">
                My billable progress
              </span>
              <span className="text-xs text-muted-foreground">{progress.cycle.label}</span>
            </div>

            <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs uppercase text-muted-foreground">Billed</span>
                <span className="tabular-nums">
                  <span className="font-medium">{formatHours(progress.billedHours)}</span>{' '}
                  <span className="text-xs text-muted-foreground">
                    ({formatDays(progress.billableDays)} days)
                  </span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs uppercase text-muted-foreground">Actual</span>
                <span className="tabular-nums font-medium">{formatPercent(progress.actualPercent)}</span>
              </div>

              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs uppercase text-muted-foreground">Target</span>
                <span className="tabular-nums">
                  {/* An em dash, never an invented number: no week in this
                      cycle stated a utilisation target, and a made-up one is a
                      figure the operator could be judged against. */}
                  {progress.targetHours === null || progress.targetDays === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      <span className="font-medium">{formatHours(progress.targetHours)}</span>{' '}
                      <span className="text-xs text-muted-foreground">
                        {/* The server's own targetDays, never
                            targetHours/dailyHours: Sphere360 rounds the target
                            to one decimal in DAYS before converting, and
                            dividing back out here would undo that and render
                            16.79 where the card says 16.80. */}
                        ({formatDays(progress.targetDays)} days)
                      </span>
                    </>
                  )}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs uppercase text-muted-foreground">Target</span>
                <span className="tabular-nums font-medium">
                  {progress.targetPercent === null
                    ? <span className="text-muted-foreground">—</span>
                    : formatPercent(progress.targetPercent)}
                </span>
              </div>
            </div>

            {progress.targetHours !== null && progress.targetHours > 0 && (
              <div
                className="mt-2 h-1.5 overflow-hidden rounded bg-muted"
                role="progressbar"
                aria-label="Billed hours against this cycle's target"
                aria-valuemin={0}
                aria-valuemax={progress.targetHours}
                aria-valuenow={progress.billedHours}
                aria-valuetext={`${formatHours(progress.billedHours)} of ${formatHours(progress.targetHours)}`}
              >
                {/* Width only — the figures above carry the same information in
                    text, so nothing here is conveyed by colour alone. */}
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.min(100, (progress.billedHours / progress.targetHours) * 100)}%` }}
                />
              </div>
            )}

            <div className="mt-2 text-xs text-muted-foreground">
              Day {progress.elapsedWorkingDays} of {progress.workingDays} working days
              {' · '}{progress.remainingWorkingDays} remaining
              {progress.dailyHoursSource === 'config' &&
                ` · ${progress.dailyHours}h/day from your local config, not Sphere360`}
            </div>

            {/* The row Sphere360 cannot show. It must never read as work still
                owed: most of it is the SAME work already counted in Billed
                above, so the two are not additive and the note says so on the
                same line it appears. */}
            <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
              <span>
                measured by session-jibble:{' '}
                <span className="tabular-nums font-medium text-foreground">
                  {progress.measuredHours.toFixed(2)} h
                </span>
              </span>
              <div>
                What this app measured over the cycle — it overlaps the hours already filed above,
                so do not add the two.
              </div>
            </div>

            {progress.allocations.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {progress.allocations.map(a => (
                  <span key={`${a.projectId}-${a.projectCode}`}>
                    <span className="font-medium text-foreground">{a.projectCode}</span>
                    {' · '}{a.plannedMandays} mandays planned
                  </span>
                ))}
              </div>
            )}

            {/* Partial, not wrong. Naming the count matters: the operator can
                only judge how much of the cycle is missing if they know how
                many weeks failed. */}
            {progress.weekErrors.length > 0 && (
              <div className="mt-2 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs">
                <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                <span>
                  {progress.weekErrors.length} week
                  {progress.weekErrors.length === 1 ? '' : 's'} of this cycle could not be read
                  ({progress.weekErrors[0].message}), so Billed and Actual are partial — the real
                  figures can only be higher.
                </span>
              </div>
            )}

            {progress.allocationsError && (
              <div className="mt-2 text-xs text-muted-foreground">
                Planned allocations unavailable ({progress.allocationsError.message}) — this is not
                the same as having none planned.
              </div>
            )}
          </div>
        )}

        {progressError && (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>{progressError}</span>
          </div>
        )}

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
          // Before the sync's start date this day belongs to Jibble, not to
          // Sphere360. The server drafts nothing for it; the shortfall is
          // suppressed here too, because a shortfall is measured against a
          // floor this system never owed for that day. Same string compare the
          // server uses — YYYY-MM-DD sorts in calendar order.
          const preCutover = !!data.syncFrom && date < data.syncFrom;
          const measured = data.beforeCutover.find(d => d.date === date)?.hours ?? 0;
          const short = isWorkday && !preCutover
            ? parseFloat(Math.max(0, data.dailyMinimumHours - total).toFixed(2))
            : 0;

          return (
            <div key={date} className="rounded-lg border p-3">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{dayLabel(date)}</span>
                {/* Only an obligated day (Mon-Fri) names a minimum — a weekend
                    shows nothing, since it carries none. A holiday chip sits
                    ALONGSIDE that minimum, not instead of it: Sphere360's own
                    working-day count does not exempt public holidays either,
                    so a Mon-Fri holiday still owes the floor and still shows
                    its shortfall below. The chip explains why the day looks
                    unusual; it does not claim the day is off the hook. */}
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {preCutover ? (
                    <span className="rounded bg-slate-100 px-1 text-slate-700 normal-case">
                      before sync start (Jibble)
                    </span>
                  ) : (
                    <>
                      {isWorkday && `minimum ${data.dailyMinimumHours}h`}
                      {isHoliday && (
                        <span className="rounded bg-blue-100 px-1 text-blue-800 normal-case">
                          holiday
                        </span>
                      )}
                    </>
                  )}
                </span>
              </div>

              {/* The measured hours still get shown — they are real work, and
                  hiding them would look like the day was never worked. What
                  they do NOT get is a drafted row: this day is already
                  reconciled in the timesheet that owned it. */}
              {preCutover && (
                <div className="mt-2 text-sm text-muted-foreground tabular-nums">
                  {measured.toFixed(2)} h measured — filed in Jibble, not drafted here.
                </div>
              )}

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
                  {/* Neither a warning nor a tick before the cutover: both are
                      verdicts against a daily floor this system never owed for
                      that day, and a green tick would claim it was met. */}
                  {preCutover
                    ? null
                    : short > 0
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
