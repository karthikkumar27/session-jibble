# Sphere360 Timesheet Sync

**Date:** 2026-08-28
**Status:** Approved design, not yet implemented
**Scope:** session-jibble — Sphere360 API client, folder→project mapping, week draft/merge, week-view UI

## Problem

session-jibble measures hours per project per day, but filing them into Sphere360
is manual retyping. `docs/billing-accuracy-plan.md` decision 7 already reserved a
write path for this — *"duration is fully automatic; attribution is a minimal human
step"* — targeting Jibble. Sphere360 replaces Jibble as the timesheet of record, so
this spec is that decision's write path, not a new feature.

The API is known:

```
POST https://sphere360.airasia.com/api/timesheets/upsert
{
  "resourceId": "<employee uuid>",
  "weekStart":  "2026-08-24T00:00:00.000Z",   // Monday, UTC midnight
  "entries": [
    { "projectId": "1804361",                  // optional — non-project rows omit it
      "activityId": "<uuid>",                  // required
      "workDate":   "2026-08-26",              // bare local date
      "hours":      0.67,                      // fractional, 2dp
      "comments":   "free text, \n allowed" }
  ]
}
```

## What this can and cannot do

**It drafts the coding rows of a week. It cannot draft the week.**

Measured against the same week as the reference payload:

| Day | session-jibble measured | Filed in Sphere360 |
|---|---|---|
| Mon 2026-08-24 | 6.13 h | — |
| Tue 2026-08-25 | 1.59 h | — |
| Wed 2026-08-26 | 6.37 h | 7.67 h (1.0 scrum + 1.0 social + 5.0 dev + 0.67 meeting) |
| Thu 2026-08-27 | 3.46 h | — |
| **Mon–Thu** | **17.55 h** | ≥ 32 h required (4 × 8 h floor) |

Two things follow, and both are load-bearing:

1. Claude Code witnesses roughly **half** a working week. Scrums, meetings, reviews
   and social time are invisible to it. The sync fills a slice and leaves the rest.
2. On Wednesday the measured figure (6.37 h) **exceeds** the filed dev row (5.0 h).
   Substituting it would push the day to 9.04 h — which is **fine**, since 8 h is a
   floor and over-logging is permitted. But it is still a number nobody measured
   against a filed row of 5.0 h, so the operator confirms rather than the tool
   deciding. Measured active time is not a drop-in replacement for filed hours.

### The hours are known to be overstated

`docs/billing-accuracy-plan.md` measures the current duration engine at roughly
**−25%** once its four corrections land (drop SDK runs, presence-gate, cap silent
gaps at 10 min, resolve cross-project overlap by message density). It states plainly:
*"The current 607 h figure is not conservative and should not be billed as-is."*

This spec **does not** implement those corrections. It therefore ships under an
explicit assumption:

> Drafted hours are uncorrected measurements. The draft UI labels them as such, and
> the operator edits before confirming. The sync's contract with the duration engine
> is an injected function, so when billing-accuracy lands the corrected numbers flow
> through with **no change to any module in this spec**.

If that labelling is unacceptable, the correct sequencing is billing-accuracy first,
this second. That is a scheduling call, not a design one.

## Decisions

| Decision | Choice | Rejected alternative |
|---|---|---|
| Write posture | Draft → human confirm → POST | Auto-submit on cron — writes IDE-derived hours into a system of record unreviewed; billing-accuracy open items say "never auto-submit unreviewed entries" |
| Auth | `SPHERE360_TOKEN` in `backend/.env`, read at call time | Token in chat/committed config — lands in transcript, memory and observation stores; several places nobody thinks to rotate |
| Auth transport | Bearer header from env | MCP server — no Sphere360 server exists; wrapping one POST that only our own backend calls does not earn the machinery |
| Surface | Dedicated week view | Bolt onto `HoursChart` date selection — an arbitrary date set spanning weeks becomes N week-replacing writes, and a partially-selected week risks clobbering unselected days |
| Entry shape | Collapse per `(projectId, activityId, workDate)`, comments merged as lines | One row per repo — more rows than filed by hand, and contradicts the reference payload which bundles two repos into one 5 h row |
| Hours | Measured, editable, shown against filed rows and a day total | Auto-scale to fill the day — the number written would not be a number measured |
| Project attribution | Mapping file supplies a **prefill**; the draft row stays editable | Static folder→projectId map — contradicts billing-accuracy decision 7, which states attribution cannot be derived and must be picked |
| Folder matching | Reuse `categorize.js` longest-prefix-wins | A second matching rule — would drift from the category rules already tuned |
| Unmapped folders | Visible "not included" section | Silent omission — mirrors why `uncategorized` exists rather than defaulting |

## Architecture

New directory `backend/lib/sphere360/`. Each module has one job; two are pure.

| Module | Responsibility | I/O |
|---|---|---|
| `client.js` | Only module touching the network. `fetchWeek()`, `upsertWeek()`, `fetchTaxonomy()`. Reads env at **call** time so a rotated token needs no restart. | Network |
| `mapping.js` | Load / validate / save folder→project prefills. Mirrors `config.js`'s validate-then-atomic-write. | Disk |
| `draft.js` | Pure. `(weekSessions, mapping) → entries[]`, collapsed and comment-merged. | none |
| `merge.js` | Pure. `(filed, drafted) → union[]`. The safety core. | none |
| `week.js` | Local date ↔ Monday `weekStart` UTC instant. | none |

`draft.js` and `merge.js` are pure because they are where a bug silently corrupts a
system of record. Both are fully unit-testable with no token and no network.

### The hours-source seam

`draft.js` receives hours through an injected accessor, never by reaching into the
duration engine:

```js
// hoursFor(projectPath, date) -> number
buildDraft({ weekStart, sessions, mapping, hoursFor })
```

The two inputs have strictly separate roles and must not both carry duration:
`sessions` supplies the **set** of `(projectPath, date)` pairs active in the week and
the excerpts that become comments; `hoursFor` is the **sole** authority on how many
hours each pair contributes. `draft.js` never reads a duration field off a session.
That split is what makes the corrected engine a drop-in later.

Today `hoursFor` wraps the existing `dailyActive` map. When billing-accuracy lands it
wraps the corrected intervals instead. This mirrors how `categorize.js` injects
platform behaviour rather than reading `process.platform` — the same reasoning, that
a policy which will change should not be welded into the module that consumes it.

### Timezone handling

`weekStart` is a UTC-midnight instant; `workDate` is a bare local date. CLAUDE.md's
standing rule — never `toISOString()` for date labels — holds for `workDate` and must
be **deliberately broken** for `weekStart`.

`week.js` is the only place that conversion is allowed, carries a comment saying why,
and is covered by tests at the UTC+8 boundary where local Monday and UTC Monday differ.
No other module may construct a `weekStart`.

## Mapping config

New file `~/.claude/session-jibble.timesheet.json`, validated the way category rules are.

```json
{
  "version": 1,
  "resourceId": "89f714e1-b2c2-4002-b197-577ef5399683",
  "projects": [
    {
      "label": "SkyIQ / Development",
      "roots": ["~/ai-research", "~/skyiq-crew-profile-web", "~/skyiq-reports"],
      "projectId": "1804361",
      "activityId": "5dbfdeb3-f41e-42c0-8410-d2d1725c1041"
    }
  ],
  "dailyMinimumHours": 8
}
```

- `roots` resolve by longest-prefix-wins via `categorize.js`'s matcher. Only the
  **matcher** is reused, not the work/nonWork rules — billing-accuracy decision 6
  replaces those with git-remote billability, and this mapping survives that change.
- `projectId` / `activityId` are **prefills**. The draft row exposes both as editable,
  seeded with last-used-per-root, per decision 7.
- Unknown top-level keys ignored on read, dropped on write.
- `resourceId` lives here rather than `.env` — it is identity, not a secret.
- `dailyMinimumHours` is a **floor, not a ceiling**. Logging more than it is normal
  and unremarkable; the UI flags a day only when the total falls *short*. It never
  scales, caps or alters a drafted number. Defaults to 8 when absent.

## Data flow

```
1. pick week   ──▶ GET /api/sphere360/week?start=2026-08-24
2. backend         client.fetchWeek()                → filed[]
                   sessions in week + draft.build()  → drafted[]
                   ──▶ { filed, drafted, unmapped, byDay[], taxonomy }

where `byDay[]` is one row per calendar day of the week —
`{ date, filedHours, draftedHours, totalHours, shortBy }` — precomputed
server-side so the day totals and the over/under warning cannot drift from the
entries they summarise.

3. UI              renders two-tier table; operator edits hours / project / comments
4. confirm     ──▶ POST /api/sphere360/week { weekStart, entries }
5. backend         client.fetchWeek()   ← RE-READ, fresh
                   merge.js(freshFiled, edited)
                   client.upsertWeek(union)
```

Step 5 re-reads rather than trusting step 2's copy. A draft may be minutes old and the
week may have been edited in Sphere360's own UI meanwhile; writing a stale union would
erase that edit. One extra request closes the window.

## Merge safety

The endpoint is named `upsert` and carries the whole week's `entries[]`. **This spec
assumes it replaces the week** — the conservative reading. Every rule below follows
from that assumption; if the probe shows it merges server-side, the rules stay correct
but become belt-and-braces.

1. **Preserve by default.** Every filed entry not deliberately replaced appears in the
   union verbatim, unmodified.
2. **Ownership key.** A drafted row "owns" a filed row when
   `(workDate, projectId, activityId)` match — the same triple the collapse groups by.
3. **Collisions are shown, never silent.** A filed row matching a drafted row's key is
   rendered "will be replaced" in the draft UI. The operator decides; the merge never
   resolves a collision on its own.
4. **Count invariant.** Refuse to POST when
   `union.length < filed.length - deliberateReplacements.length`.
   A cheap assertion that catches a whole class of dropped-row bug before it reaches
   the network.
5. **No blind retry on write.** A failed `upsert` against a week-replacing endpoint is
   not safely retryable — the first attempt may have partially applied. Surface the
   failure; the operator re-drafts against a fresh read. `fetchWeek` may retry freely.

Rule 1 plus rule 4 together are the feature's safety story: the meeting rows, the
scrum, the social entry — none of which this app can see — survive every write.

## Error handling

| Condition | Behaviour |
|---|---|
| `SPHERE360_TOKEN` missing or blank | 412 with an actionable message. No network call attempted. |
| 401 / 403 | Distinct message: "token expired or invalid — refresh `SPHERE360_TOKEN` in `backend/.env`". This is the *expected recurring* failure and must not read as a generic error. |
| Network / 5xx on GET | Surface status; safe to retry. |
| Network / 5xx on POST | Surface status; **no auto-retry** (rule 5). Prompt a fresh draft. |
| `hours <= 0`, `hours > 24`, missing `activityId`, `workDate` outside the posted week | Rejected client-side before POST, with the offending row highlighted. |
| Folder with hours but no mapping | Not an error. Non-blocking "unmapped — N h not included" notice. |
| No sessions in the selected week | Empty draft, filed rows still shown. Confirm is disabled. |

## UI — week view

New `TimesheetWeek` surface, reusing `ui/sheet.tsx` from the Settings work.

**8 h is a floor.** A day over it is unremarkable and gets a quiet ✓; the only state
worth an operator's attention is a day that falls **short**, because that is the one
that needs more logged before the week can be filed.

```
Wed 2026-08-26                                minimum 8h
──────────────────────────────────────────────────────────
already filed  (untouched by this sync)
    Daily scrum — skyiq 2.0 A and C                1.00 h
    ice creame party                               1.00 h
    meeting with Khaliq Infra team …               0.67 h

drafted from session-jibble                    ⚠ uncorrected
    [SkyIQ / Development ▾]              [ 6.37 ] h
        skyiq-crew-profile-web · skyiq-reports
        measured 6.37 h · editable

not included
    ~/side-projects/foo — 0.4 h (unmapped)
──────────────────────────────────────────────────────────
day total  9.04 h                              ✓ 1.04 over
```

The state that actually needs surfacing is the short day:

```
Tue 2026-08-25                                minimum 8h
──────────────────────────────────────────────────────────
already filed                                    — none —

drafted from session-jibble                    ⚠ uncorrected
    [SkyIQ / Development ▾]              [ 1.59 ] h
──────────────────────────────────────────────────────────
day total  1.59 h                     ⚠ 6.41 h below minimum
                          this day is not ready to file
```

Week footer carries the same roll-up: `17.55 h logged · 22.45 h below the 40 h floor`,
so the operator sees at a glance which days still need attention before confirming.

- Week picker defaults to the current week; Mon–Sun always rendered, including empty days.
- Filed rows are visually inert — no controls — so it is unambiguous what this app authored.
- The ⚠ uncorrected badge links to `docs/billing-accuracy-plan.md`'s reasoning.
- Confirm is disabled until every drafted row has a `projectId` and `activityId`.
- A short day **never blocks confirm**. It is a prompt, not a gate — the missing hours
  are usually non-coding work this app cannot see, and the operator adds them in
  Sphere360 directly.

## Testing

Node's built-in runner, `backend/test/*.test.js`, matching the existing six suites.

| Suite | Covers |
|---|---|
| `sphere360-draft.test.js` | Collapse per key; comment merge order; multi-repo day; zero-hour day dropped; unmapped folder excluded but reported; injected `hoursFor` honoured |
| `sphere360-merge.test.js` | **A filed row survives the union** — the single most important test in the feature. Plus collision marking, the count invariant, and an empty-draft no-op |
| `sphere360-week.test.js` | Monday derivation; UTC+8 boundary where local Monday ≠ UTC Monday; Sunday and year-boundary weeks |
| `sphere360-mapping.test.js` | Validation errors; longest-prefix resolution; unknown keys dropped; atomic write |
| `sphere360-client.test.js` | Injected `fetch`. Missing-token path; 401 mapped to its distinct message; **no live network** |

Frontend: `tsc -b` from `frontend/` (not `--noEmit` — the solution config type-checks
zero files), and `npx eslint .` holding at the one-error baseline.

## Open questions — settled by a read-only probe before implementation

Each has a documented safe assumption; the probe confirms or corrects it.

| Question | Assumption used | If wrong |
|---|---|---|
| Does `upsert` replace the week or merge server-side? | **Replaces** | Merge rules become redundant, not incorrect. No redesign. |
| Do GET'd entries carry a stable `id`? | No — ownership by `(workDate, projectId, activityId)` | Switch rule 2 to id-based ownership; strictly safer. |
| Where does the activity/project taxonomy come from? | A GET endpoint discoverable on the timesheet page | Fall back to a hand-maintained list in the mapping file. |
| Token TTL (JWT `exp`) | Short, roughly 1 h | Long-lived tokens would make an unattended mode *possible* — still rejected on posture grounds. |

The probe is read-only: fetch the week, decode the JWT locally, read the taxonomy
endpoint. Nothing is posted.

## Out of scope

- The four billing-accuracy corrections. Consumed through `hoursFor` when they land.
- Non-coding entries (scrum, meetings, leave). Invisible to Claude Code by nature.
- Editing or deleting filed rows. This sync only adds and replaces its own.
- Any unattended or scheduled write path.
