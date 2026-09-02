import Feather from '@expo/vector-icons/Feather';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';

/**
 * Shared wizard furniture — one visual language across every report flow.
 *
 * Cascading pickers were failing observers: with several stages stacked on one
 * screen it was impossible to tell that a new choice had opened below the fold.
 * Prompt makes the current instruction loud and coloured; Crumb shows what has
 * already been chosen and is the way back.
 */

/** The one instruction for the current stage. Deliberately hard to miss. */
export function Prompt({ children }: { children: ReactNode }) {
  return (
    <View className="mb-2 mt-1 flex-row items-center rounded-xl bg-hawk-green px-3 py-2">
      <Feather name="chevron-right" size={15} color={BRAND.gold} />
      <Text className="pl-1 text-sm font-bold text-hawk-gold">{children}</Text>
    </View>
  );
}

/**
 * A completed stage: shows the choice, tapping it returns to that stage.
 * Sized as a real target (44px tall) rather than a thin chip — going back is a
 * primary action in a cascading picker, not an afterthought.
 */
export function Crumb({ label, onPress }: { label: string; onPress: () => void }) {
  const ui = useUi();
  return (
    <Pressable
      onPress={onPress}
      className="mb-2 flex-row items-center self-start rounded-2xl bg-card px-4 py-3 active:opacity-70"
    >
      <Feather name="arrow-left" size={15} color={ui.tint.good.ink} />
      <Text className="pl-2 text-sm font-bold text-good-ink">{label}</Text>
      <Text className="pl-2 text-xs font-semibold text-faint">change</Text>
    </Pressable>
  );
}
