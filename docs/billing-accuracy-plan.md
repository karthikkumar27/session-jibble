# Billing-grade time capture — design decisions

Status: agreed via design interview, not yet implemented.
Date: 2026-08-25

## Purpose

Hours from this app feed **client / internal billing**, not a personal dashboard.
That sets the bar: every billed minute must trace to an artifact on disk, and the
direction of error must be *under*-reporting, never over.

## What the investigation found

Measured against real data (8,399 history entries, 1,560 transcripts, 246 days):

| Finding | Evidence |
|---|---|
| `history.jsonl` records **only prompts you typed** — one line per Enter press | no start/stop/heartbeat events exist anywhere |
| It is blind to ~half of all sessions | 788 sessions in history vs 1,557 in transcripts |
| Transcripts are **16× denser** but expire after ~30 days | history spans 2025-09-30→2026-08-25; transcripts only 2026-07-23→2026-08-25 |
| 1,464 transcript sessions are **not human work** | `entrypoint=sdk-cli` (1,059) / `sdk-py` (395) — automated SDK runs |
| Concurrent sessions are **summed, not unioned** | 607.0 h reported vs 575.8 h wall-clock — 5.1% inflation |
| Almost all overlap is **cross-project** | 29.4 h of 31.2 h — same minute billed to two projects |
| The 30-min threshold carries 41% of reported hours | gaps of 15–30 min contribute 251 h of 607 h |
| **The billing dimension is absent from all local data** | Jibble bills on TRIP tickets; only 5.5% of time sits on a branch carrying any ticket id |

## Decisions

### 1. Data source — transcripts forward, history frozen behind
`history.jsonl` is the durable spine (246 days) but coarse. Transcripts are
high-resolution but perishable (~30 days). Build an ingestion job that snapshots
`entrypoint=cli` transcripts into our own append-only store **before the window
closes**. Every day this is delayed, another day of evidence is lost permanently.

Pre-cutover days keep the old prompt-derived numbers and are explicitly marked as
computed by the legacy method. No retroactive restatement of already-billed hours.

### 2. Filter to human work
Exclude `sdk-cli` and `sdk-py` — those are ruflo / claude-flow swarm runs that
execute unattended and in parallel; billing them would inflate hours beyond
defending.

A transcript is classified in three steps, in this order (see
`backend/lib/transcript.js`). **The order is load-bearing — do not collapse it.**

1. **Stated entrypoint**, scanned across *all* raw rows, not only `user`/`assistant`
   rows. Some transcripts state `entrypoint` only on a `system` / `mode` /
   `last-prompt` row. A stated `sdk-cli` / `sdk-py` always excludes the file, and
   always outranks step 2.
2. **Inferred interactive**, used only when no row states an entrypoint: the
   presence of `userType: "external"` non-sidechain rows means a human was typing.
3. **Otherwise unclassified** — excluded from billing, and its resume offset is
   held at 0 so it re-reads until it classifies rather than losing the rows.

Step 2 exists because the original `cli`-only rule silently dropped **164 real
billable rows** across 10 transcripts in `gitlab.airasia` repos, reported them as
"non-interactive", and would have let them expire. Narrowing this back to
`entrypoint == 'cli'` reintroduces that data loss.

### 3. Presence gate
Claude's working time counts only when a human message falls within 10 minutes.
Costs ~10.5 h (4.4%) of history. Every billed minute then has the operator
demonstrably at the keyboard nearby.

### 4. Cap silent gaps, don't threshold them
Keep 30-minute session continuity, but **any single silent stretch contributes at
most 10 billable minutes**. Costs ~14% vs today. Removes the indefensible cliff
where 29:59 bills in full and 30:01 bills zero; reduces to one sentence:
*"no single silent stretch bills more than ten minutes."*

### 5. Resolve overlap by message density
When two projects are active in the same minute, divide that minute in proportion
to message counts in the window. Never bills more than one elapsed hour per hour,
and the split derives from an artifact that can be pointed at in a dispute.
Same-project overlap (1.8 h) is simply unioned.

### 6. Client mapping by git remote
Billable iff `origin` host is `airline.gitlab.airasia.com` (485.7 h, 91.2%).
`github.com` (47.0 h) is personal and **not billable**. Explicit path roots as
fallback for repos with no remote (68.5 h currently).

Replaces the current `work`/`nonWork` binary in `backend/lib/categorize.js`.
The existing `contains` substring rules (`"web"`, `"crew"`, `"rules"`,
`"middleware"`) must be **removed** for billing — a broad fragment is one new repo
away from silently misbilling.

### 7. TRIP attribution stays human — because it cannot be derived
Jibble bills against 661 TRIP-ticket projects. Nothing Claude Code records
identifies which TRIP a session served: not folders, not remotes, not branches
(5.5% coverage), not commits (0 TRIP references in 695 commits). This is missing
information, not a hard inference — no algorithm recovers it.

So: **duration is fully automatic; attribution is a minimal human step.** The app
proposes hours per repo per day; the operator picks the TRIP from a searchable list
with last-used-per-repo prefilled. A few clicks a day.

## Net effect on reported hours

Roughly −25% against today's headline number, from four corrections that are each
individually defensible: dropping SDK runs, presence-gating, capping silent gaps,
and de-duplicating overlap. The current 607 h figure is not conservative and should
not be billed as-is.

## Open items (recommendations, not yet ratified)

- **Ingestion cadence** — recommend a scheduled job every 6 h; transcripts are
  append-only so track `(file, byte offset)` and read only the tail.
- **Store format** — recommend append-only JSONL under `~/.claude/session-jibble/`,
  one record per counted interval with its evidence (session id, repo, branch,
  message uuids). This *is* the audit trail.
- **Jibble write path** — recommend `add_hour_entries` after the TRIP is assigned,
  never on ingest. Writes are live org data; do not auto-submit unreviewed entries.
- **Cutover date** — recommend the first date with full transcript coverage
  (2026-07-23), stated explicitly on any invoice that spans it.
