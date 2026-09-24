import { t } from '@/lib/i18n';

/**
 * "Saturday, 16 January 2027" in the chosen language.
 *
 * Not toLocaleDateString: the home cards passed 'en-GB', so every language got
 * English day and month names, and a phone's ICU cannot be relied on for
 * ha/ig/yo anyway. The names live in the i18n files and are read at call time,
 * never at import (the language can change after this module loads).
 */
export function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const days = t('n.lib.dates.weekdays').split(',');
  const months = t('n.lib.dates.months').split(',');
  return t('n.lib.dates.long', {
    v0: days[d.getDay()],
    v1: d.getDate(),
    v2: months[d.getMonth()],
    v3: d.getFullYear(),
  });
}
