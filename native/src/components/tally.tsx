import { type DimensionValue, Text, View } from 'react-native';

export type Tally = { total: number; fraudulent: number; legit: number; inconclusive: number };

/** Three-colour split of how the crowd judged a case. Docket list and case file
 *  share it so a case never looks different depending on where you meet it. */
export function TallyBar({ t }: { t: Tally }) {
  const tot = Math.max(1, t.total);
  const pct = (n: number): DimensionValue => `${(n / tot) * 100}%`;
  return (
    <View className="mt-2 h-2 flex-row overflow-hidden rounded-full bg-hawk-mist">
      <View className="h-full bg-red-600" style={{ width: pct(t.fraudulent) }} />
      <View className="h-full bg-hawk-green" style={{ width: pct(t.legit) }} />
      <View className="h-full bg-amber-600" style={{ width: pct(t.inconclusive) }} />
    </View>
  );
}

export const STATUS_TONE: Record<string, string> = {
  open: 'bg-amber-100 text-amber-800',
  fraudulent: 'bg-red-100 text-red-700',
  legit: 'bg-emerald-100 text-hawk-leaf',
  inconclusive: 'bg-neutral-100 text-neutral-600',
};

export function StatusChip({ status }: { status: string }) {
  return (
    <View className={`rounded-full px-2 py-0.5 ${STATUS_TONE[status] ?? ''}`}>
      <Text className="text-[10px] font-bold">{status.toUpperCase()}</Text>
    </View>
  );
}
