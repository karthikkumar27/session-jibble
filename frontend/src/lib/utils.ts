import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Returns YYYY-MM-DD in the browser's local timezone — matches what the backend
// now returns. Never use toISOString() for date labels: that's UTC and shifts
// dates for users east of UTC (e.g. UTC+8 Malaysia).
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Formats a YYYY-MM-DD string for display. Splits the string by hand rather
// than letting Date parse it: new Date('2026-07-20') is read as UTC midnight,
// which renders as "Jul 19" east of UTC — the same trap localDateStr avoids.
export function formatDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Local ISO-8601 timestamp with offset, e.g. 2026-08-13T11:54:00+08:00.
// Deliberately not toISOString(): that emits UTC, which would stamp an export
// made at 00:30 in UTC+8 with the previous day's date.
export function localIsoString(d: Date = new Date()): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return `${date}T${time}${offset}`;
}
