// Pure. Sphere360's "MY BILLABLE PROGRESS" card, recomputed from the weeks a
// cycle spans.
//
// The route fetches; this decides. Everything the card shows is derived here so
// it can be tested against the operator's live card without a network call —
// route wiring in this codebase has no test harness, so any arithmetic left in
// the route is arithmetic nobody checks.
//
// A week is passed in as either { weekStart, week, entries } or
// { weekStart, error }. Failure is DATA here, not an exception: a cycle spans
// five weeks and one expired token must not blank a card the operator uses to
// decide whether they are behind. The totals come from the weeks that
// succeeded and weekErrors names the ones that did not, so the UI can say the
// figure is partial rather than say nothing.

const { workingDaysIn, elapsedWorkingDays } = require('./cycle');
const { resolveDailyMinimum, toPositiveFiniteNumber } = require('./mapping');

const round2 = (n) => parseFloat(n.toFixed(2));
const round1 = (n) => parseFloat(n.toFixed(1));

// Live rows carry the flag twice: `isBillable` on the entry and again on the
// nested `activity`. The row's own flag wins — an entry explicitly marked
// non-billable must not be rescued by its activity's default, or the operator's
// social row rejoins BILLED and the card reads 14h where Sphere360 says 13h.
//
// Neither present means NOT billable. Over-reporting BILLED is the failure that
// has someone stop filing while they are actually behind; under-reporting only
// has them look.
function isBillableEntry(entry) {
  if (typeof entry?.isBillable === 'boolean') return entry.isBillable;
  return entry?.activity?.isBillable === true;
}

// Filed hours must be filtered to the CYCLE, not to the weeks fetched. The
// opening week starts up to six days before the cycle and the closing week runs
// up to six days past it; counting those days here bills them in two cycles at
// once. Dates are bare YYYY-MM-DD by the time they reach this module
// (client.js normalises them on read), so a string compare is the range test.
function billedHoursIn(entries, start, end) {
  let total = 0;
  for (const e of entries) {
    if (!e || e.workDate < start || e.workDate > end) continue;
    if (!isBillableEntry(e)) continue;
    const h = Number(e.hours);
    // One unusable row would otherwise turn every figure on the card into NaN.
    if (!Number.isFinite(h)) continue;
    total += h;
  }
  return total;
}

function summarizeCycle({ cycle, today, weeks = [], mapping }) {
  const { start, end } = cycle;

  const ok = weeks.filter(w => !w.error);
  const weekErrors = weeks
    .filter(w => w.error)
    .map(w => ({ weekStart: w.weekStart, code: w.error.code ?? null, message: w.error.message ?? '' }));

  // The first week of a cycle often has no timesheet yet, so the resource must
  // be taken from whichever week actually carries one — reading weeks[0]
  // blindly would report the configured fallback while a later week states the
  // operator's real capacity. Both figures come from the SAME resource: a
  // capacity from one week and a utilisation target from another would be a
  // pair that never existed.
  const resourceWeek = ok.find(w => w.week?.resource)?.week ?? null;

  // resolveDailyMinimum, not a second copy of `weeklyCapacityHours / 5`: the
  // week route already derives the daily floor that way, and two copies of the
  // same rule is two things to drift. It also reports which source won, so the
  // card never presents a configured guess as Sphere360's own figure.
  const { hours: dailyHours, source: dailyHoursSource } = resolveDailyMinimum(mapping, resourceWeek);

  // No configured fallback on purpose. dailyMinimumHours has one because a
  // sensible default exists (8); a utilisation target does not — inventing 73
  // would put a number on the card that Sphere360 never said. null renders as
  // "—" rather than as a target the operator might be judged against.
  //
  // toPositiveFiniteNumber (mapping.js), not a bare typeof check: Sphere360
  // serves targetUtilization as a string ("73") on the live API.
  const targetPercent = toPositiveFiniteNumber(resourceWeek?.resource?.targetUtilization);

  const workingDays = workingDaysIn(start, end);
  const elapsed = elapsedWorkingDays(start, today, end);
  const capacityHours = round2(workingDays * dailyHours);

  // TARGET is rounded to ONE DECIMAL IN DAYS and only then converted to hours.
  // Not the other way round, and not a display artefact — the rounding place is
  // load-bearing, and it was derived from the operator's live card:
  //
  //   raw target days     0.73 x 23       = 16.79
  //   round to 1 decimal  round(16.79, 1) = 16.8    -> card renders "16.80 days"
  //   target hours        16.8 x 8        = 134.4   -> card renders "134h 24m"
  //
  // All three roundings were checked against that card and only 1dp reproduces
  // it: 0dp gives 17.0 days / 136h 00m, and 2dp gives 16.79 days / 134h 19m.
  // The unrounded product (targetPercent / 100 * capacityHours) gives 134.32h,
  // which is what this module shipped first and what put it five minutes below
  // the dashboard it exists to mirror, on every cycle.
  //
  // So do NOT "simplify" the rounding away, and do not compute targetHours
  // directly from capacityHours: targetDays is the primary figure and
  // targetHours is derived from it. The card's own "16.80 days" is a
  // two-decimal rendering of a one-decimal value — that is Sphere360's
  // formatting, not a second rounding, so targetDays is returned in its own
  // right rather than left for the UI to divide back out of targetHours (which
  // would reintroduce exactly the unrounded value this removes).
  const targetDays = targetPercent === null
    ? null
    : Math.round((targetPercent / 100) * workingDays * 10) / 10;
  const targetHours = targetDays === null ? null : round2(targetDays * dailyHours);

  const billedHours = round2(ok.reduce((sum, w) => sum + billedHoursIn(w.entries ?? [], start, end), 0));

  return {
    workingDays,
    elapsedWorkingDays: elapsed,
    remainingWorkingDays: workingDays - elapsed,
    dailyHours,
    dailyHoursSource,
    capacityHours,
    targetPercent,
    targetDays,
    targetHours,
    billedHours,
    // Sphere360's own "days" unit: hours over one day's capacity, never over 24.
    billableDays: dailyHours > 0 ? round2(billedHours / dailyHours) : 0,
    actualPercent: capacityHours > 0 ? round1(billedHours / capacityHours * 100) : 0,
    weekErrors,
  };
}

module.exports = { summarizeCycle, isBillableEntry, billedHoursIn };
