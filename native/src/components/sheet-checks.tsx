/**
 * WHAT THE SHEET PHOTO SAYS BESIDES ITS COUNTS, on the counts step: the election
 * it names, and which of this race's ballot parties it shows (lib/sheet-counts.ts,
 * the same code the website and Lite run).
 *
 * INEC pastes one result poster PER RACE, and the public photographs whichever
 * is nearest, so a Senate poster sent as the Presidential result is caught here,
 * while the observer can still walk back to the wall. Warns, never blocks: the
 * reader misses words, an officer's hand-filled grid may list only some parties,
 * and the observer is the one looking at the sheet. Twin of app/app.js
 * paintSheetChecks.
 */
import { Text, View } from 'react-native';

import { t as i18nT } from '@/lib/i18n';
import { ELECTION_TYPES } from '@/lib/races';
import { partiesMissing, partiesSeen, raceOffice, sheetOffice } from '@/lib/sheet-counts';

const officeName = (office: string) => {
  const t = ELECTION_TYPES.find((e) => e.code === office);
  return t ? i18nT(t.labelKey) : office;
};

/** The warnings for this photo, race and ballot; [] when there is nothing to say. */
export function sheetCheckLines(text: string | null | undefined, race: string | null | undefined, ballot: string[] | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const found = sheetOffice(text);
  const asked = raceOffice(race ?? '');
  if (found && asked && found !== asked) {
    out.push(i18nT('n.components.sheet-checks.other-race', { v0: officeName(found), v1: officeName(asked) }));
  }
  const missing = ballot?.length ? partiesMissing(partiesSeen(text, ballot), ballot) : [];
  if (missing.length) out.push(i18nT('n.components.sheet-checks.parties-not-found', { v0: missing.join(', ') }));
  return out;
}

export function SheetChecks({ text, race, ballot }: { text?: string | null; race?: string | null; ballot?: string[] | null }) {
  const lines = sheetCheckLines(text, race, ballot);
  if (!lines.length) return null;
  return (
    <View className="mb-3 rounded-2xl bg-warn px-4 py-3" accessibilityRole="alert">
      {lines.map((l) => (
        <Text key={l} className="py-0.5 text-sm font-semibold text-warn-ink">{l}</Text>
      ))}
    </View>
  );
}
