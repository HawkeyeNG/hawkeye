import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import type { Contest } from '@/lib/api';

/**
 * The answer an observer gets when they pick a state no election is running in.
 *
 * Shared by result and collation reporting deliberately: both list every state
 * (the register is nationwide), so both must dead-end the same way — say plainly
 * that nothing is open here, name what IS being covered, and hand over the one
 * thing that is always worth doing, mapping a polling unit. Two different
 * dead-ends for the same situation reads as a broken app.
 */
export function NoElection({ state, contest }: { state: string; contest: Contest | null }) {
  return (
    <View className="rounded-2xl bg-card px-4 py-5">
      <Text className="text-base font-bold text-ink">No Active Election in {state}</Text>
      <Text className="pt-1 text-sm text-muted">
        {contest
          ? `Hawkeye is currently covering the ${contest.election}. Reporting opens for other states when their elections are scheduled.`
          : 'No election is currently open for reporting.'}
      </Text>
      <Text className="pt-2 text-sm text-muted">
        You can still map polling units anywhere in Nigeria — that work counts before any
        election is called.
      </Text>
      <Pressable
        className="mt-3 items-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
        onPress={() => router.replace('/map-unit')}
      >
        <Text className="text-base font-bold text-hawk-gold">Map a polling unit</Text>
      </Pressable>
    </View>
  );
}
