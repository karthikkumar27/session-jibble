# Init — session-jibble session startup

You are starting a Claude Code session on **session-jibble**, a personal Claude session analytics dashboard.

## Step 1: Orient yourself

Read the project documentation:

```
Read CLAUDE.md
```

Key facts to internalize:
- Backend: **Express on port 8089**, reads `~/.claude/` directly with `fs` (no database)
- Frontend: **React 19 + Vite on port 8088**, proxies `/api/*` to `:8089`
- Start both with `npm run dev` from the project root
- **Never use `toISOString()` for dates** — all dates must be local timezone (UTC+8 Malaysia)

## Step 2: Check what's running

```bash
lsof -ti:8089 && echo "backend UP" || echo "backend DOWN"
lsof -ti:8088 && echo "frontend UP" || echo "frontend DOWN"
```

If servers are down and the user needs them: `npm run dev`

## Step 3: Know the file map

| What to change | File |
|----------------|------|
| Session parsing / active-time logic | `backend/server.js` |
| Today's KPI cards | `frontend/src/components/TodayCards.tsx` |
| Today's project pills | `frontend/src/components/TodayWork.tsx` |
| Daily bar chart | `frontend/src/components/HoursChart.tsx` |
| Sessions table | `frontend/src/components/SessionsTable.tsx` |
| Shared types | `frontend/src/lib/types.ts` |
| Date utility | `frontend/src/lib/utils.ts` → `localDateStr()` |
| UI primitives | `frontend/src/components/ui/` |

## Step 4: Recall the non-obvious invariants

1. **Active time**: gaps > 30 min between messages are ignored (`GAP_THRESHOLD` in `server.js`).
2. **Midnight splitting**: `attributeGap()` splits time gaps that cross local midnight across two calendar days — don't simplify this logic.
3. **Sort order**: sessions sorted by `lastActivityAt`, not `startedAt`.
4. **Multi-day sessions**: `activeDates[]` array — frontend filters today's sessions with `s.activeDates.includes(today)`.
5. **Excerpt source**: the backend prefers `ai-title` entries from transcript `.jsonl` files over the raw `display` field from history.
6. **Only file written by this app**: `~/.claude/session-stats.json` (completion overrides).

## Step 5: Confirm user's goal

Ask what the user wants to work on, then proceed.
