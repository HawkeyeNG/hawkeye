import { type DimensionValue, Text, View } from 'react-native';

export type Tally = { total: number; fraudulent: number; legit: number; inconclusive: number };

/** Three-colour split of how the crowd judged a case. Docket list and case file
 *  share it so a case never looks different depending on where you meet it.
 *
 *  The segments are the semantic *-ink colours rather than fixed reds and
 *  greens: on the dark theme a bg-hawk-green segment sat almost exactly on the
 *  track's own colour and the bar read as empty. */
export function TallyBar({ t }: { t: Tally }) {
  const tot = Math.max(1, t.total);
  const pct = (n: number): DimensionValue => `${(n / tot) * 100}%`;
  return (
    <View className="mt-2 h-2 flex-row overflow-hidden rounded-full bg-surface">
      <View className="h-full bg-bad-ink" style={{ width: pct(t.fraudulent) }} />
      <View className="h-full bg-good-ink" style={{ width: pct(t.legit) }} />
      <View className="h-full bg-warn-ink" style={{ width: pct(t.inconclusive) }} />
    </View>
  );
}

/**
 * Chip colours per verdict, as a background/foreground pair.
 *
 * It used to be one class string holding both, applied to the wrapping View —
 * which meant the text colour never applied at all (React Native inherits text
 * style from a parent Text, never from a View) and the tints were hardcoded
 * bg-*-100, so in dark mode the chip stayed pale. Both halves are now semantic
 * tokens, and the foreground goes on the Text where it can actually land.
 */
export const STATUS_TONE: Record<string, { bg: string; text: string }> = {
  open: { bg: 'bg-warn', text: 'text-warn-ink' },
  fraudulent: { bg: 'bg-bad', text: 'text-bad-ink' },
  legit: { bg: 'bg-good', text: 'text-good-ink' },
  inconclusive: { bg: 'bg-line', text: 'text-muted' },
};

export function StatusChip({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.inconclusive;
  return (
    <View className={`rounded-full px-2 py-0.5 ${tone.bg}`}>
      <Text className={`text-[10px] font-bold ${tone.text}`}>{status.toUpperCase()}</Text>
    </View>
  );
}
