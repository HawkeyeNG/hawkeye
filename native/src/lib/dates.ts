import { t } from '@/lib/i18n';

/**
 * "Saturday, 16 January 2027" in the chosen language.
 *
 * Not toLocaleDateString: the home cards passed 'en-GB', so every language got
 * English day and month names, and a phone's ICU cannot be relied on for
 * ha/ig/yo anyway. The names live in the i18n files and are read at call time,
 * never at import (the language can change after this module loads).
 */
/** A bare YYYY-MM-DD is read at local noon, so no timezone moves it a day. */
const at = (x: string | Date) =>
  x instanceof Date ? x : new Date(/^\d{4}-\d{2}-\d{2}$/.test(x) ? `${x}T12:00:00` : x);

const monthName = (d: Date, short: boolean) =>
  // Short names are the receipt's list: already translated and reviewed.
  t(short ? 'receipt.months' : 'n.lib.dates.months').split(',')[d.getMonth()];

/** "16 Jan" — what toLocaleDateString('en-GB', { day, month: 'short' }) gave. */
export function dayMonth(x: string | Date): string {
  const d = at(x);
  return t('n.lib.dates.day-month', { v0: d.getDate(), v1: monthName(d, true) });
}

/** "16 January 2027", or "16 Jan 2027" with short. */
export function dayMonthYear(x: string | Date, short = false): string {
  const d = at(x);
  return t('n.lib.dates.day-month-year', { v0: d.getDate(), v1: monthName(d, short), v2: d.getFullYear() });
}

/** "Saturday, 16 January, 08:30" — a reporting window's opening moment. */
export function dayTime(x: string | Date): string {
  const d = at(x);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return t('n.lib.dates.weekday-day-month-time', {
    v0: t('n.lib.dates.weekdays').split(',')[d.getDay()],
    v1: d.getDate(),
    v2: monthName(d, false),
    v3: hm,
  });
}

export function longDate(iso: string): string {
  const d = at(iso);
  const days = t('n.lib.dates.weekdays').split(',');
  const months = t('n.lib.dates.months').split(',');
  return t('n.lib.dates.long', {
    v0: days[d.getDay()],
    v1: d.getDate(),
    v2: months[d.getMonth()],
    v3: d.getFullYear(),
  });
}
