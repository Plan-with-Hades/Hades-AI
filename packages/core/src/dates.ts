/** Working-day arithmetic (Monday to Friday). Dates are ISO yyyy-mm-dd strings in local time. */

export function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function isWeekend(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}

/** Moves forward to the next working day if `d` falls on a weekend. */
export function nextWorkingDay(d: Date): Date {
  const out = new Date(d);
  while (isWeekend(out)) out.setDate(out.getDate() + 1);
  return out;
}

export function addWorkingDays(iso: string, days: number): string {
  const d = nextWorkingDay(fromISO(iso));
  let left = Math.round(days);
  const step = left >= 0 ? 1 : -1;
  while (left !== 0) {
    d.setDate(d.getDate() + step);
    if (!isWeekend(d)) left -= step;
  }
  return toISO(d);
}

/** Working days from `a` to `b` (positive when b is later). */
export function workingDaysBetween(a: string, b: string): number {
  const start = fromISO(a);
  const end = fromISO(b);
  const sign = end >= start ? 1 : -1;
  const cur = new Date(sign > 0 ? start : end);
  const stop = sign > 0 ? end : start;
  let n = 0;
  while (cur < stop) {
    cur.setDate(cur.getDate() + 1);
    if (!isWeekend(cur)) n++;
  }
  return n * sign;
}

export function formatShort(iso: string): string {
  return fromISO(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
