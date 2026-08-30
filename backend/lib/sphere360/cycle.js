// Pure. The billing cycle Sphere360's "MY BILLABLE PROGRESS" card measures.
//
// A cycle runs the 26th of one month to the 25th of the next, and is addressed
// by the month it ENDS in — so 26 Aug - 25 Sep 2026 is "2026-09". This is NOT
// the calendar month, even though the same product speaks calendar months on
// its capacity-planning endpoint. Two period models in one system: mixing them
// moves six days of billing into the wrong cycle, so nothing here derives a
// period from a calendar month.
//
// Every date operation delegates to week.js, which is this codebase's only
// module allowed to know how a local date becomes an instant. A second date
// implementation here would be a second place to get the UTC/local distinction
// wrong, and getting it wrong moves a Monday out of the working-day count.

const { addDays, dayOfWeek, dateParts, fromDateParts, mondayOf } = require('./week');

const CYCLE_START_DAY = 26;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Plain integer arithmetic on a (year, month) pair — not date arithmetic, so it
// stays here. fromDateParts refuses month 13, which is what makes forgetting
// the year roll a loud failure rather than a mislabelled cycle.
const nextMonth = ({ year, month }) =>
  (month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 });
const prevMonth = ({ year, month }) =>
  (month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 });

// -> { start, end, monthKey }
function cycleFor(localDate) {
  const { year, month, day } = dateParts(localDate);   // validates, and refuses 2026-02-30
  const startMonth = day >= CYCLE_START_DAY ? { year, month } : prevMonth({ year, month });
  const endMonth = nextMonth(startMonth);
  return {
    start: fromDateParts(startMonth.year, startMonth.month, CYCLE_START_DAY),
    end: fromDateParts(endMonth.year, endMonth.month, CYCLE_START_DAY - 1),
    monthKey: `${endMonth.year}-${String(endMonth.month).padStart(2, '0')}`,
  };
}

// YYYY-MM-DD sorts lexicographically in calendar order, so a string compare is
// the range check — no Date needed, and no chance of a zone shifting one.
function assertRange(start, end) {
  dateParts(start);
  dateParts(end);
  if (start > end) {
    // 0 would be indistinguishable from "a two-day weekend" and would divide
    // into the capacity as a silent zero.
    throw new Error(`Cycle start ${start} must be on or before its end ${end}`);
  }
}

const isWeekday = (date) => {
  const dow = dayOfWeek(date);
  return dow >= 1 && dow <= 5;
};

// Every calendar date in the cycle, inclusive of both ends. Weekends included:
// measured local work happens on them even though they owe no timesheet floor.
function datesIn(start, end) {
  assertRange(start, end);
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

// Plain Mon-Fri count. Public holidays are deliberately NOT deducted: the
// operator's live card reports 23 working days for 26 Aug - 25 Sep 2026, a
// cycle containing both Merdeka Day and Malaysia Day, and every other figure
// on that card reproduces only from this rule. Sphere360's 73% target
// utilisation is the slack that already absorbs holidays, leave and
// non-billable time — deducting them here as well would double-count it and
// make this app disagree with the dashboard it mirrors. server.js's byDay
// makes the same choice for the same reason; keep the two consistent.
function workingDaysIn(start, end) {
  return datesIn(start, end).filter(isWeekday).length;
}

// Working days from the cycle start through today, inclusive — the card's
// "Day 3 of 23". Clamped at both ends: viewing a past cycle passes a `today`
// beyond its end and must not keep counting, and viewing a future one must
// not go negative.
function elapsedWorkingDays(start, today, end) {
  assertRange(start, end);
  dateParts(today);
  if (today < start) return 0;
  return workingDaysIn(start, today < end ? today : end);
}

// The Monday of every week overlapping the cycle, so a caller knows which weeks
// to fetch. Sphere360 stores timesheets by week, and a cycle opens mid-week —
// starting at the cycle's own start date would miss the week carrying 26-28
// Aug, three working days of billing.
function weekStartsIn(start, end) {
  assertRange(start, end);
  const out = [];
  for (let monday = mondayOf(start); monday <= end; monday = addDays(monday, 7)) {
    out.push(monday);
  }
  return out;
}

// The card's own heading. A fixed month table rather than toLocaleDateString:
// this string is produced on the server, where the locale is the machine's and
// not the reader's. The year appears once when both ends share it, and on both
// ends when they do not — '26 Dec – 25 Jan 2027' would read as December 2027.
function cycleLabel(start, end) {
  assertRange(start, end);
  const s = dateParts(start);
  const e = dateParts(end);
  const left = `${s.day} ${MONTHS[s.month - 1]}${s.year === e.year ? '' : ` ${s.year}`}`;
  return `${left} – ${e.day} ${MONTHS[e.month - 1]} ${e.year}`;
}

module.exports = { cycleFor, workingDaysIn, elapsedWorkingDays, weekStartsIn, datesIn, cycleLabel };
