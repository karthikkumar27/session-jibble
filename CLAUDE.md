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

## Data sources (all from `~/.claude/`)

| File/Dir | Purpose |
|----------|---------|
| `history.jsonl` | Raw conversation entries — source of truth for session IDs, timestamps, and project paths |
| `sessions/*.json` | Session metadata (`startedAt`, `updatedAt`) — fallback when no history entries exist |
| `projects/<dir>/<sessionId>.jsonl` | Session transcripts — mined for `ai-title` entries used as session excerpts |
| `session-stats.json` | Completion overrides written by this app (not a Claude file) |

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
- `session-stats.json` is the only file this app writes to disk.
- Frontend port is 8088, backend port is 8089 — these are hardcoded in `vite.config.ts` and `server.js`.
