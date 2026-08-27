# session-jibble — Claude Session Tracker

A personal analytics dashboard that reads Claude Code's local session data from `~/.claude/` and presents it as a real-time productivity tracker.

## What it does

- Tracks every Claude Code session by reading `~/.claude/history.jsonl`
- Calculates **active time** per session (ignoring idle gaps > 30 min)
- Displays a daily bar chart of hours worked (last 30 days)
- Groups today's work by project, with status badges
- Lets you mark sessions as completed / reopen them
- Persists completion overrides in `~/.claude/session-stats.json`

## Architecture

```
session-jibble/           ← monorepo root (concurrently orchestrator)
├── backend/
│   └── server.js         ← Express API, port 8089
├── frontend/
│   └── src/
│       ├── App.tsx        ← root component, data fetching, auto-refresh
│       ├── components/
│       │   ├── TodayCards.tsx    ← KPI cards (hours, projects, sessions, completed)
│       │   ├── TodayWork.tsx     ← project pill strip for today's work
│       │   ├── HoursChart.tsx    ← Recharts bar chart, 30-day view
│       │   ├── SessionsTable.tsx ← paginated session list with status toggle
│       │   └── ui/               ← shadcn-style primitives (Badge, Button, Card)
│       └── lib/
│           ├── types.ts   ← Session, DayStats interfaces
│           └── utils.ts   ← cn(), localDateStr()
└── package.json           ← root scripts (dev = both servers via concurrently)
```

## Running

```bash
# Both servers (recommended)
npm run dev

# Backend only (port 8089)
npm run backend

# Frontend only (port 8088)
npm run frontend

# Backend unit tests (resolver + config validation)
npm test --prefix backend
```

Frontend is at **http://localhost:8088**.
Backend API is at **http://localhost:8089**.
Vite proxies `/api/*` → `http://localhost:8089` so the frontend always calls `/api/...`.

## Backend API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats` | All sessions, sorted by most recent activity |
| GET | `/api/daily-stats` | Hours per calendar day (all time) |
| POST | `/api/sessions/:id/done` | Mark session completed |
| POST | `/api/sessions/:id/reopen` | Reopen a session |
| GET | `/api/config` | Category rules, with `source` and any load error |
| PUT | `/api/config` | Validate and atomically save category rules |
| GET | `/api/projects` | Distinct project folders with resolved category and all-time hours |

## Data sources (all from `~/.claude/`)

| File/Dir | Purpose |
|----------|---------|
| `history.jsonl` | Raw conversation entries — source of truth for session IDs, timestamps, and project paths |
| `sessions/*.json` | Session metadata (`startedAt`, `updatedAt`) — fallback when no history entries exist |
| `projects/<dir>/<sessionId>.jsonl` | Session transcripts — mined for `ai-title` entries used as session excerpts |
| `session-stats.json` | Completion overrides written by this app (not a Claude file) |
| `session-jibble.config.json` | Per-user work/non-work folder rules written by this app (not a Claude file) |
| `session-jibble/events.jsonl` | Our durable copy of interactive transcript events (not a Claude file) |
| `session-jibble/ingest-state.json` | Per-transcript byte offsets so ingest reads only new data |
| `session-jibble/ingest.lock` | Exclusive lock so two ingest runs cannot both append |
| `session-jibble.timesheet.json` | Folder→Sphere360 project/activity prefills (not a Claude file) |

## Key design decisions

### Timezone handling (critical)
The server and frontend both use **local timezone** date strings, never `toISOString()` (which returns UTC and shifts dates for UTC+8 Malaysia). Both sides implement `localDateStr()` identically — `YYYY-MM-DD` from the machine's local clock.

### Active time model
A 30-minute idle gap threshold (`GAP_THRESHOLD = 30 * 60 * 1000`) means long pauses between messages don't inflate session durations. Only consecutive-message gaps under 30 min are counted as active time.

### Midnight boundary splitting
The `attributeGap()` function in `server.js` correctly splits a time gap that straddles local midnight across two calendar days. This prevents daily stats from attributing "late night → early morning" work entirely to the wrong day.

### Session sorting
Sessions are sorted by `lastActivityAt` (most recent message timestamp), not `startedAt`. A session started last week but active today ranks above yesterday's sessions.

### Multi-day sessions
A session that spans multiple days (e.g., started Tuesday, continued Wednesday) has an `activeDates: string[]` array. The frontend uses `activeDates.includes(today)` to correctly surface these in the "Today" view.

### Category classification
Project folders resolve to `work`, `nonWork`, or `uncategorized` via
`backend/lib/categorize.js`. The most specific folder wins (longest matching path
prefix), and path rules always outrank name-substring rules. Comparison is
case-insensitive on Windows and macOS and case-sensitive on Linux, matching each
platform's filesystem. Platform behaviour is injected, never read from
`process.platform` inside the resolver, so both branches are testable from one machine.

Unmatched folders become `uncategorized` rather than silently counting as non-work —
a missing rule should be visible, not quietly under-report work hours.

### Transcript ingestion (time-critical)
`~/.claude/projects/**/*.jsonl` holds message-level timestamps far richer than
`history.jsonl`, but Claude Code deletes them after ~30 days. `npm run ingest`
copies interactive events into `~/.claude/session-jibble/events.jsonl` before they
expire. It is incremental (byte offsets in `ingest-state.json`) and idempotent
(dedupe by event `uuid`), so running it often is free and running it twice is
harmless.

It stores **raw events, never computed durations** — duration rules will change,
and intervals can always be recomputed from events, while events cannot be
recovered once deleted. Sidechain (subagent) rows are stored too, tagged
`isSidechain`; whether they count toward a duration is the duration engine's
decision, not capture's.

#### How a transcript is classified
Billability is decided per file, in this order:

1. **A stated `entrypoint` wins.** `fileEntrypoint()` scans the file's **raw
   lines**, not only its `user`/`assistant` rows — the field also appears on
   `system`, `attachment` and `mode` rows, and some transcripts state it on
   nothing else. `cli` is billable; `sdk-cli` and `sdk-py` are excluded as
   unattended agent runs. A stated value always beats an inferred one, including
   one this ingest cached earlier.
2. **No `entrypoint` anywhere → look for a human.** `hasInteractiveMarkers()`
   treats a `userType: "external"` non-sidechain row, or a `last-prompt` /
   `permission-mode` row, as proof someone was at the keyboard, and classifies
   the file `interactive` (billable). These markers appear in SDK transcripts
   too, so this rule is only ever consulted when step 1 found nothing.
3. **Neither → `unknown`.** The file is not captured and its offset is left
   unchanged so it re-reads until it classifies. The run reports these
   separately from SDK exclusions, because an unclassified file means capture
   may be incomplete while an SDK one does not.

Do not collapse steps 1 and 3 back into "only `entrypoint === 'cli'` counts" —
that dropped real human work in billable repos and reported it as
"non-interactive".

#### Concurrency
The `SessionStart` hook is global, so two runs overlapping is routine. The
ledger's dedupe set is per-process and cannot prevent two runs appending the
same uuids, so `bin/ingest.js` takes an `O_EXCL` lockfile
(`~/.claude/session-jibble/ingest.lock`, `lib/lock.js`) first and **exits 0**
when it is held — the next session start captures anything this run skipped. A
lock whose pid is dead, or that is older than five minutes, is reclaimed.

Ingest is wired to a global `SessionStart` hook in `~/.claude/settings.json` (global,
not project — the work being captured spans every repo, not just this one). It runs
`async` and logs to `~/.claude/session-jibble/ingest.log`. Review it with `/hooks`.

**Never truncate or delete `events.jsonl`** — it is the durable copy that outlives
the transcripts, and nothing can rebuild it once they expire. To force a full
re-read, delete `ingest-state.json` only; uuid dedupe makes that purely additive.

### Sphere360 timesheet sync
`TimesheetWeek` drafts the week's coding rows into Sphere360's week-scoped
`/api/timesheets/upsert`, and never writes without an operator confirming.

The endpoint replaces the whole week, so `lib/sphere360/merge.js` unions drafted
rows onto everything already filed and refuses to post a union that lost a row.
Meetings, scrums and leave are invisible to this app and must survive every write —
that is what `sphere360-merge.test.js` exists to protect.

Drafted hours are **uncorrected**: `docs/billing-accuracy-plan.md` measures the
current engine ~25% high, and those corrections have not landed. `draft.js` takes
hours through an injected `hoursFor()`, so the corrected engine drops in without
touching the sync. The UI labels every drafted row until then.

`SPHERE360_TOKEN` lives in `backend/.env` (gitignored) and is read at call time,
so a re-pasted token needs no restart. 8h is a **floor**, not a target — only a
short day is flagged, and it never blocks confirm.

## Frontend component details

### `TodayCards`
Fetches `/api/daily-stats` independently (not from the sessions prop) so its "Hours Today" card matches the bar chart exactly — both use the same daily-stats endpoint.

### `HoursChart`
Builds a 30-day window client-side by iterating back from today, then joins against the API data. Zero-fills days with no data so the bar chart always shows a complete 30-day range.

### `SessionsTable`
- Paginated at 20 rows per page
- Today's rows highlighted in blue
- Multi-day sessions show a `CalendarRange` icon with day count
- Status toggled optimistically (local state updated immediately, API called in background)

## Tech stack

| Layer | Stack |
|-------|-------|
| Backend | Node.js, Express 5, cors |
| Frontend | React 19, TypeScript, Vite 8 |
| Styling | Tailwind CSS 3, shadcn/ui primitives via Radix UI |
| Charts | Recharts |
| Icons | Lucide React |
| State | useState/useEffect (no external state library) |

## Things to know before changing code

- **Do not use `toISOString()` for date labels** anywhere — breaks for UTC+N timezones.
- **The active-time gap threshold is 30 minutes** — changing it affects all historical stats retroactively.
- Backend reads `~/.claude/` directly with `fs` — no database, no migrations.
- This app writes two files to disk: `session-stats.json` (completion overrides) and `session-jibble.config.json` (category rules).
- Frontend port is 8088, backend port is 8089 — these are hardcoded in `vite.config.ts` and `server.js`.
- **TypeScript checking in `frontend/` requires `tsc -b`, not `tsc --noEmit`**: `tsconfig.json` is a solution config (`"files": []` plus `references`), so `npx tsc --noEmit` against it type-checks zero files and always exits 0 — it looks like a passing check and proves nothing. `npx tsc -b` from `frontend/` is the command that actually compiles the sources. `tsconfig.app.json` carries `"ignoreDeprecations": "6.0"` because TypeScript 6 errors on the deprecated `baseUrl` option, and that config error would otherwise abort `tsc -b` before it compiles anything.
- **Lint baseline is one pre-existing error**: `npx eslint .` from `frontend/` reports exactly one error (`react-hooks/set-state-in-effect` in `App.tsx`, from the data-fetch effect calling `fetchData()` synchronously). Treat that as the baseline — a change is clean when the count stays at one, not zero. Fixing it requires restructuring the fetch/refresh lifecycle, which nothing has needed.
