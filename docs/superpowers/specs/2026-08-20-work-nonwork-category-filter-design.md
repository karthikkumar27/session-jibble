# Work / Non-work Category Filter

**Date:** 2026-08-20
**Status:** Approved design, not yet implemented
**Scope:** session-jibble — backend classification, config persistence, Settings UI, dashboard filter

## Problem

session-jibble reports total hours across every Claude Code session, with no way to
separate employer work from side projects. The dashboard is moving from single-user
to team use, so the folder-to-category mapping cannot be hard-coded — each person
needs their own.

## Decisions

| Decision | Choice | Rejected alternative |
|---|---|---|
| Categories | Fixed: `work`, `nonWork`, `uncategorized` | User-defined N categories — dynamic filter/chart/export for no clear gain at three buckets |
| Non-work label | "Non-work" | "Personal" — claims a motive the folder path cannot know |
| Unmatched folders | Visible `uncategorized` bucket | Silent fallback to non-work — hides a missing rule as under-reported work |
| Overlap resolution | Longest matching path wins | Work-list-first — cannot express a personal repo inside a work root |
| Rule location | Backend | Frontend — `/api/daily-stats` has no project dimension, so a frontend rule forces the chart to re-sum rounded per-session values and drift from the endpoint |
| Config location | `~/.claude/session-jibble.config.json` | Repo file — per-user by nature; matches existing `session-stats.json` ownership |
| Config editing | Settings UI writing that file | Hand-edit only — teammates should not need to write valid JSON |

## Config schema

Version 1:

```json
{
  "version": 1,
  "work":    { "roots": ["~/gitlab-projects"], "contains": ["skyiq"] },
  "nonWork": { "roots": ["~/side-projects"],   "contains": [] }
}
```

- `roots` — folder path prefixes. `~`-prefixed (expanded server-side via `os.homedir()`)
  or absolute in POSIX, Windows-drive, or UNC form. Separators may be `/` or `\` in any
  mix; see Cross-platform path handling.
- `contains` — case-insensitive substrings matched against the whole **expanded,
  separator-normalized absolute** path, home directory included. Because separators are
  normalized to `/` first, a rule like `projects/skyiq` matches on every platform. A
  substring that happens to occur in the home directory name would match everything; the
  Settings UI warns when a `contains` rule matches every known project.
- Both lists in both categories may be empty.
- Unknown top-level keys are ignored on read and dropped on write.
- `version` is written by the app and reserved for future migrations. A file with an
  unrecognised version is treated as unreadable — see the Edge cases table and the
  `error` field on `GET /api/config`.

### Shipped defaults

The default config is **empty** — no roots, no contains. Seeding one person's folder
layout as a default would be wrong for every other member of a team.

### Unconfigured state

"Nothing configured yet" is a distinct UI state, not an empty filter. The trigger is
**every one of the four rule lists being empty**, regardless of whether that came from
the shipped defaults or from a saved file — a user who saves an empty config should get
the same guidance as a first-run user, not a filter where everything is uncategorized.

- The category filter control is **hidden** — a four-way filter where everything
  falls in one bucket is noise.
- A "Set up categories" prompt appears in the header instead, opening the Settings panel.
- The Settings panel's Uncategorized list is pre-populated with every folder from the
  user's history, sorted by total hours descending, so first-run assignment is a few clicks.

Once any rule exists, the filter control appears and the prompt disappears.

## Resolver

`classifyProject(cwd, config, opts?) -> "work" | "nonWork" | "uncategorized"`

Pure function, no I/O, no dependency on Express or `fs`. Lives in `server.js` beside
the other path helpers and is exported for tests.

```
# Platform behaviour is an explicit parameter, never read from process.platform
# inside the function — that is what makes both platforms testable from one machine.
defaultOpts = {
    homeDir:       os.homedir(),
    caseSensitive: process.platform !== "win32" && process.platform !== "darwin"
}

normalize(p, opts):
    p = p.trim()
    if p === "~" or p.startsWith("~/") or p.startsWith("~\\"):
        p = opts.homeDir + p.slice(1)
    p = p.replace(/\\/g, "/")               # backslashes -> forward slashes
    p = p.replace(/\/+/g, "/")               # collapse repeats, incl. UNC leader
    if /^[a-zA-Z]:/.test(p):
        p = p[0].toUpperCase() + p.slice(1)  # canonical drive letter: c:/ -> C:/
    if p.length > 1: p = p.replace(/\/+$/, "")   # strip trailing "/", keep root "/"
    return p

compare(a, b, opts):
    return opts.caseSensitive ? a : a.toLowerCase()   # applied to both sides

matchesRoot(cwd, root, opts):
    c = compare(cwd, opts); r = compare(root, opts)
    return c === r || c.startsWith(r + "/")           # segment-aware

classifyProject(cwd, config, opts = defaultOpts):
    if !cwd: return "uncategorized"
    cwd = normalize(cwd, opts)

    # Tier 1 — path rules, longest match wins
    best = null                                   # { category, length }
    for category in ["work", "nonWork"]:
        for root in config[category].roots:
            r = normalize(root, opts)
            if matchesRoot(cwd, r, opts):
                if best === null
                   or r.length > best.length
                   or (r.length === best.length and category === "work"):
                    best = { category, length: r.length }
    if best: return best.category

    # Tier 2 — name rules, always case-insensitive, matched against the
    # separator-normalized path so "projects/skyiq" works on every platform
    needle = cwd.toLowerCase()
    if config.work.contains.any(s => needle.includes(normalizeSep(s).toLowerCase())):
        return "work"
    if config.nonWork.contains.any(s => needle.includes(normalizeSep(s).toLowerCase())):
        return "nonWork"

    # Tier 3
    return "uncategorized"
```

### Cross-platform path handling

The resolver runs on Windows, macOS and Linux. Four things differ between them, and
each is handled in `normalize()` rather than scattered through the matching logic:

| Concern | Handling |
|---|---|
| Separators | Backslashes converted to `/` before any comparison, so `C:\Users\x\proj` and `C:/Users/x/proj` are the same path. Repeated separators collapse, which also normalizes the `\\server\share` UNC leader to `/server/share` |
| Case sensitivity | Path comparison is **case-insensitive on Windows and macOS, case-sensitive on Linux** — matching each platform's actual filesystem semantics. macOS is included deliberately: APFS is case-insensitive by default, so treating `~/Work` and `~/work` as distinct there would misfile folders the OS itself considers identical |
| Drive letters | Upper-cased during normalization, so a config holding `c:/projects` matches a recorded cwd of `C:\projects` |
| Home expansion | `~` expands via `os.homedir()`, which resolves correctly on Windows (`C:\Users\name`). Both `~/x` and `~\x` are accepted |

`contains` rules stay case-insensitive on every platform — they are name fragments, not
paths, and a case-sensitive substring rule is a support burden with no upside. The
needle is separator-normalized too, so a single rule like `projects/skyiq` works
everywhere.

Because `caseSensitive` and `homeDir` are injected rather than read from
`process.platform` inside the function, the Windows and Linux code paths are both
testable from a single machine — which is the only practical way to keep this honest,
given the team will not have a Windows CI runner.

Properties this guarantees:

- **Segment-aware prefixes.** `~/gitlab-projects-archive` does not match the root
  `~/gitlab-projects`. A naive `startsWith` would misfile it.
- **Path rules always outrank name rules.** A substring has no path depth, so there is
  no meaningful way to compare its specificity against a folder prefix. Ranking all
  path rules above all name rules avoids inventing a fake specificity score.
- **Deterministic ties.** Equal-length roots in opposing lists resolve to `work`.
  Note that two *different* roots of equal length can never both match the same path —
  matching requires the path to start with each, which forces them to be identical. So
  this tiebreak is only reachable when the same root appears in both lists, which
  `PUT /api/config` rejects (validation 5). It exists solely to keep a hand-edited file
  deterministic rather than order-dependent.
- **Exceptions work.** `~/gitlab-projects -> work` plus
  `~/gitlab-projects/test-mcp -> nonWork` classifies
  `~/gitlab-projects/test-mcp/stock-ticker-mcp-telegram` as non-work, because the
  second root is longer.

## API

### `GET /api/config` (new)

```json
{
  "config": { "version": 1, "work": {...}, "nonWork": {...} },
  "source": "file",
  "error": null
}
```

`source` is `"file"` or `"defaults"`. `error` is a human-readable string when the file
exists but could not be used; `config` then holds the defaults.

### `PUT /api/config` (new)

Body is a full config object — no partial updates. Responses:

- `200` — `{ config }`, the normalized config as saved.
- `400` — `{ errors: [{ path: "work.roots[2]", message: "..." }] }`, no write performed.

Validation, applied in order:

1. `work` and `nonWork` present, each with array `roots` and `contains`.
2. Every entry is a non-empty string after trimming.
3. Every `roots` entry is `~`-prefixed or absolute in one of the accepted forms:
   POSIX (`/srv/work`), Windows drive (`C:\work` or `C:/work`), or UNC
   (`\\server\share`). Relative paths are rejected — there is no meaningful working
   directory to resolve them against. The check accepts all forms on every platform, so
   a config file stays readable when synced to a different OS rather than erroring.
4. Entries deduped within a list after normalization.
5. The same normalized root may not appear in both `work.roots` and `nonWork.roots` —
   this is always a mistake and the tiebreak would hide it.
6. Each list capped at 200 entries.

Writes are atomic: serialize to `<file>.tmp`, then `fs.renameSync` over the target.
Rename is atomic on POSIX, so a concurrent reader sees either the old file or the new
one, never a truncated one.

### `GET /api/projects` (new)

Distinct project paths from `history.jsonl` with resolved category, powering the
Settings panel's Uncategorized list. `hours` is all-time active hours for that path and
`sessions` its all-time session count — this list is for deciding how a folder should be
categorised, so it must not be limited to the 30-day chart window:

```json
[{ "path": "/Users/x/gitlab-projects/skyiq-host-web", "displayPath": "~/gitlab-projects/skyiq-host-web",
   "category": "work", "hours": 12.4, "sessions": 7 }]
```

Sorted by `hours` descending.

### `GET /api/stats` (changed)

Each session gains `category: "work" | "nonWork" | "uncategorized"`. All existing
fields unchanged.

### `GET /api/daily-stats` (changed)

```json
{ "date": "2026-08-20", "hours": 6.7, "workHours": 5.5, "nonWorkHours": 1.2, "uncategorizedHours": 0 }
```

`hours` keeps its exact current meaning and value. Each category field is accumulated
in **milliseconds** and converted to hours once at the end, so no per-session rounding
error accumulates within a category.

The three category fields are each rounded to 2dp independently, so their sum can
differ from `hours` by up to 0.01h (36 seconds) — three values rounded separately need
not sum to the separately-rounded total. This is accepted rather than corrected: the UI
displays exactly one of these fields at a time, at one decimal place, so the difference
is never visible. Any future UI that shows two categories side by side and a total must
derive the total by summing the parts rather than reading `hours`.

### Config lifetime

Config is read once per request, not cached at boot. The file is small, and it means a
hand-edit and a Settings-panel save follow the same code path — they cannot drift.

## Settings panel

A shadcn **Sheet** (`side="right"`), opened from a gear button in the dashboard header
that carries a visible "Settings" text label, not icon-only.

Sheet is chosen over a hand-rolled panel because it provides focus trapping,
Esc-to-close, scroll lock, and aria wiring. Hand-rolled focus management is a
High-severity anti-pattern. Cost: one new dependency, `@radix-ui/react-dialog`, plus a
new `frontend/src/components/ui/sheet.tsx` primitive.

Layout, top to bottom:

1. **Work folders** — list of rows (path + remove button), then an add-input with a
   real `<label>`. Below it, "Match by name" chips for `work.contains`.
2. **Non-work folders** — identical structure.
3. **Uncategorized** — folders no rule matched, from `GET /api/projects`, each with
   one-click "→ Work" and "→ Non-work" buttons that append that exact path as a root.
   Shows hours and session count per row so the significant ones sort to the top.
4. **Save** — loading state, then success or error feedback.

Behaviour:

- Path inputs validate **on blur**, not on submit.
- A path that is syntactically valid but does not exist on disk produces a **warning,
  not a block** — a teammate may configure before cloning a repo.
- Save is disabled while any field holds a blocking error.
- On save success the panel stays open, the success state shows, and the dashboard
  refetches stats so the effect is immediately visible behind the sheet.

### Deliberate deviation

shadcn guidance rates "use `Form` + react-hook-form" as High severity. This design
does not. The form is two string arrays with one syntactic rule, and this codebase is
explicitly useState/useEffect with no external state library. Adding react-hook-form
plus a resolver dependency would outweigh the form it manages. Plain controlled state
with on-blur validation instead. Recorded here so the choice is visible rather than
looking like an oversight.

## Filter control

A segmented control: **All · Work · Non-work · Uncategorized**.

- Radiogroup semantics with arrow-key navigation between segments.
- Visible focus ring (`focus:ring-2`); active state carried by background **and** font
  weight, never colour alone.
- The Uncategorized segment shows a count badge and is **hidden entirely when zero**,
  so a fully configured team never sees it.
- The whole control is hidden in the unconfigured state described above.
- Filter state mirrors to the URL as `?category=<token>` — read on mount,
  `replaceState` on change — so a filtered view can be shared or reloaded. Tokens are
  exactly the API values `work`, `nonWork`, `uncategorized`; the `all` state omits the
  parameter entirely. An unrecognised token falls back to `all` rather than erroring.

## Threading through the dashboard

| Component | Change |
|---|---|
| `App.tsx` | `useState<Category>('all')`, hydrated from the URL; passed to chart, cards, table |
| `HoursChart.tsx` | Selects `hours` / `workHours` / `nonWorkHours` / `uncategorizedHours`; bar colour keyed to category (All and Work keep the existing primary blue, Non-work a distinct violet, Uncategorized a neutral slate — all four verified at 4.5:1 against the card background); card title names the active filter so a screenshot is self-describing. 30-day window, zero-fill, and drag-to-select logic untouched |
| `TodayCards.tsx` | Same field selection for Hours Today; project/session/completed counts filter on `session.category` |
| `SessionsTable.tsx` | Filters rows by category **before** the date filter, so category and drag-selected ranges compose; page resets to 1 on category change |
| `exportJson.ts` | Active category stamped into the export payload |
| `lib/types.ts` | `Category` union; `category` on `Session`; new fields on the daily-stats type |

## Edge cases

| Case | Behaviour |
|---|---|
| Session with no project path | `uncategorized` |
| `cwd` exactly equals a root | Matches that root |
| Overlapping roots within one list | Longest wins; harmless |
| Identical root in both lists | Rejected at save with a field error |
| Root in one list nested under a root in the other | Allowed — this is the exception mechanism |
| Multi-day session | Category is per-session, so its hours land in the same category on every day it touched |
| Config file unreadable or unknown version | Defaults used, `error` surfaced in the API response, banner shown in UI |
| Every rule list empty | Unconfigured state — filter hidden, setup prompt shown |
| Mixed separators in one path (`C:/Users\x`) | Normalized to `/` before matching; both forms resolve identically |
| Drive letter case differs from config | Matches — drive letters are upper-cased during normalization |
| Root differing from cwd only by case | Matches on Windows and macOS, does **not** match on Linux |
| UNC path (`\\server\share\proj`) | Normalized to `/server/share/proj`; matches a root written in either form |
| Trailing separator on a root (`~/work/`) | Stripped during normalization; a bare `/` or `C:/` root keeps its trailing slash |
| Config written on one OS, read on another | Loads without error; `~`-prefixed roots keep working, OS-specific absolute roots simply match nothing |

## Verification

The repo has no test runner. This design adds `node:test` (Node built-in, zero
dependencies) covering `classifyProject` only — it is pure, and it is the one component
that silently misreports hours when wrong.

Platform-independent cases: segment-aware prefix, longest-match exception,
path-beats-name precedence, tie resolution, `~` expansion, empty config, empty cwd.

Cross-platform cases, run against **both** injected option sets from a single machine
so neither code path depends on the developer's OS: backslash and mixed-separator
input, drive-letter case, UNC normalization, trailing separators, and the
case-sensitivity split — the same fixture must classify as `work` under the
Windows/macOS options and `uncategorized` under the Linux options when only casing
differs. That last assertion is the one that would otherwise regress silently.

Everything else is covered by `tsc -b`, `eslint`, and a browser check of the four
filter states plus a save round-trip.

### Adjacent Windows gap, not fixed here

`cwdToProjectDir()` (`server.js:42`) maps a cwd to its transcript folder with
`cwd.replace(/[/. ]/g, '-')`, which does not replace backslashes. On Windows it
therefore produces the wrong folder name and session excerpts come back empty. This is
a pre-existing bug independent of categorisation, but it sits directly in the path of
anything claiming Windows support, so it is called out rather than left to surprise
someone. The fix is one character class — `/[\\/. ]/g` — and should be confirmed
against a real Windows `~/.claude/projects/` listing before being applied blind.

## Out of scope

- Per-session manual category override (config is folder-based only)
- Team-shared or synced config — each user's file is independent
- More than the three fixed categories
- Case-insensitive matching on Linux — a case-sensitive filesystem is treated as
  case-sensitive, so a Linux user must match their folder casing exactly
