/* Batch 42: date presets for the Dashboard and the Reports — plain helpers
   with no database calls, so the unit tests can check every one. Dates are
   Dhaka dates as "YYYY-MM-DD"; both ends of a range are included. */

export type ReportPreset = 'today' | 'yesterday' | 'week' | 'month' | 'last_month' | 'year' | 'all' | 'custom';

export interface DateRange {
  from: string;
  to: string;
}

export const REPORT_PRESETS: readonly { id: ReportPreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

/** The first day "All time" starts on (before the shop's first order). */
export const ALL_TIME_FROM = '2024-01-01';

function toUtc(date: string): Date {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The week starts on Saturday (the first working day in Bangladesh). */
export function weekStart(date: string): string {
  const day = toUtc(date).getUTCDay(); // 0 Sun … 6 Sat
  return addDays(date, -((day + 1) % 7));
}

export function presetRange(preset: ReportPreset, today: string, custom: DateRange): DateRange {
  const [y, m] = today.split('-').map(Number);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const d = addDays(today, -1);
      return { from: d, to: d };
    }
    case 'week':
      return { from: weekStart(today), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      const mm = String(pm).padStart(2, '0');
      return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(lastDayOfMonth(py, pm)).padStart(2, '0')}` };
    }
    case 'year':
      return { from: `${y}-01-01`, to: today };
    case 'all':
      return { from: ALL_TIME_FROM, to: today };
    default:
      return custom;
  }
}

export type DashboardPeriod = 'today' | 'month' | 'year';

/**
 * The period before, the same length so the comparison is fair: today vs
 * yesterday; this month so far (1st – today) vs the same days of last month;
 * this year so far vs the same days of last year.
 */
export function dashboardRanges(period: DashboardPeriod, today: string): { current: DateRange; previous: DateRange } {
  const [y, m, d] = today.split('-').map(Number);
  if (period === 'today') {
    const prev = addDays(today, -1);
    return { current: { from: today, to: today }, previous: { from: prev, to: prev } };
  }
  if (period === 'month') {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const mm = String(pm).padStart(2, '0');
    const pd = Math.min(d, lastDayOfMonth(py, pm));
    return {
      current: { from: `${today.slice(0, 7)}-01`, to: today },
      previous: { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(pd).padStart(2, '0')}` },
    };
  }
  const pd = Math.min(d, lastDayOfMonth(y - 1, m));
  return {
    current: { from: `${y}-01-01`, to: today },
    previous: { from: `${y - 1}-01-01`, to: `${y - 1}-${String(m).padStart(2, '0')}-${String(pd).padStart(2, '0')}` },
  };
}

/** % change from the previous period; null when there is nothing to compare. */
export function changePercent(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined) return null;
  const p = Math.round(previous * 100);
  if (p === 0) return null;
  return Math.round(((Math.round(current * 100) - p) / Math.abs(p)) * 1000) / 10;
}

/** "▲ 12.5%" / "▼ 3%" / "0%". */
export function changeText(percent: number | null): string {
  if (percent === null) return '—';
  if (percent === 0) return '0%';
  const n = Math.abs(percent);
  return `${percent > 0 ? '▲' : '▼'} ${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

/** "2026-09" months of a range, oldest first. */
export function monthsOf(range: DateRange): string[] {
  const out: string[] = [];
  let [y, m] = range.from.split('-').map(Number);
  const [ty, tm] = range.to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** "Sep 2026" from "2026-09" or "2026-09-01". */
export function shortMonth(month: string): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m] = month.split('-').map(Number);
  return `${names[m - 1]} ${y}`;
}

/** The month before the one this date is in, as its first day. */
export function previousMonthStart(today: string): string {
  const [y, m] = today.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}

/** Days between two dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86400000);
}

/** The age bucket of a due. */
export function ageBucket(days: number): '0-30' | '31-60' | '60+' {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  return '60+';
}

/** The last months that are over, newest first ("2026-09-01", …). */
export function lockableMonths(today: string, count = 12): string[] {
  const out: string[] = [];
  let m = previousMonthStart(today);
  for (let i = 0; i < count; i += 1) {
    out.push(m);
    m = previousMonthStart(m);
  }
  return out;
}
