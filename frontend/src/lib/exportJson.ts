import { localIsoString } from './utils';
import type { SessionDay } from './types';

export interface ExportPayload {
  exportedAt: string;
  selectedDates: string[];
  days: {
    date: string;
    hours: number;
    sessions: {
      sessionId: string;
      project: string;
      hours: number;
      status: string;
      excerpt: string;
    }[];
  }[];
}

// Groups the filtered session-days by calendar day. Days that were selected but
// hold no sessions are kept with an empty list, so the file reflects the range
// the user actually picked rather than silently dropping the quiet days.
export function buildExportPayload(selectedDates: string[], rows: SessionDay[]): ExportPayload {
  const byDate = new Map<string, SessionDay[]>();
  for (const date of selectedDates) byDate.set(date, []);
  for (const row of rows) byDate.get(row.date)?.push(row);

  return {
    exportedAt: localIsoString(),
    selectedDates: [...selectedDates],
    days: selectedDates.map(date => {
      const dayRows = byDate.get(date) ?? [];
      return {
        date,
        // Sum of the sessions listed directly beneath it, so the file is always
        // internally consistent — never a total its own rows don't add up to.
        hours: parseFloat(dayRows.reduce((sum, r) => sum + r.hours, 0).toFixed(2)),
        sessions: dayRows.map(r => ({
          sessionId: r.session.sessionId,
          project: r.session.project,
          hours: r.hours,
          status: r.session.status,
          excerpt: r.session.excerpt,
        })),
      };
    }),
  };
}

export function exportFilename(selectedDates: string[]): string {
  if (selectedDates.length === 0) return 'session-jibble.json';
  const first = selectedDates[0];
  const last = selectedDates[selectedDates.length - 1];
  return first === last
    ? `session-jibble-${first}.json`
    : `session-jibble-${first}_${last}.json`;
}

export function downloadJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
