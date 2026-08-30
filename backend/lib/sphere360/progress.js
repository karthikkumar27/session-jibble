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
const { resolveDailyMinimum } = require('./mapping');

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
  const rawTarget = resourceWeek?.resource?.targetUtilization;
  const targetPercent = (typeof rawTarget === 'number' && Number.isFinite(rawTarget)) ? rawTarget : null;

  const workingDays = workingDaysIn(start, end);
  const elapsed = elapsedWorkingDays(start, today, end);
  const capacityHours = round2(workingDays * dailyHours);

  // The plain documented product. NOTE: the live card for 26 Aug - 25 Sep 2026
  // renders TARGET as "134h 24m (16.80 days)" — 134.4h — where this yields
  // 134.32h ("134h 19m"), 0.08h less. 134.4 is not reachable from
  // targetUtilization 73 and capacity 184 by any multiplication (134.4/184 is
  // 73.04%). It IS reachable two ways we cannot tell apart from one
  // observation: Sphere360 rounding the target to one decimal in DAYS before
  // converting back (23 x 0.73 = 16.79 -> 16.8 -> 134.4), or the stored
  // targetUtilization actually being 73.04 and displayed rounded to 73%. This
  // keeps the multiplication, because it is the rule the API's own field
  // states and because a real 73.04 would then produce 134.4 unaided —
  // whereas a rounding rule invented here would be wrong for every operator
  // whose utilisation is not 73.
  const targetHours = targetPercent === null ? null : round2(targetPercent / 100 * capacityHours);

  const billedHours = round2(ok.reduce((sum, w) => sum + billedHoursIn(w.entries ?? [], start, end), 0));

  return {
    workingDays,
    elapsedWorkingDays: elapsed,
    remainingWorkingDays: workingDays - elapsed,
    dailyHours,
    dailyHoursSource,
    capacityHours,
    targetPercent,
    targetHours,
    billedHours,
    // Sphere360's own "days" unit: hours over one day's capacity, never over 24.
    billableDays: dailyHours > 0 ? round2(billedHours / dailyHours) : 0,
    actualPercent: capacityHours > 0 ? round1(billedHours / capacityHours * 100) : 0,
    weekErrors,
  };
}

module.exports = { summarizeCycle, isBillableEntry, billedHoursIn };
