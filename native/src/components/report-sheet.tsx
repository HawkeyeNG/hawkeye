import BottomSheet, { BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { forwardRef, useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Feather } from '@expo/vector-icons';
import { BRAND } from '@/lib/api';

/**
 * The "Report" action sheet — native twin of the chooser menu.js attaches to
 * the center tab on the web shell. Same three actions, same order.
 */
export type ReportAction = 'result' | 'incident' | 'collation';

type Props = { onAction: (a: ReportAction) => void };

const ACTIONS: { key: ReportAction; label: string; sub: string; icon: keyof typeof Feather.glyphMap }[] = [
  { key: 'result', label: 'Report a Result', sub: 'Photograph the result sheet at your unit', icon: 'camera' },
  { key: 'incident', label: 'Report an Incident', sub: 'Photo or video of what you witnessed', icon: 'alert-triangle' },
  { key: 'collation', label: 'Report a Collation', sub: 'Ward or LGA collation announcement', icon: 'layers' },
];

/** Module-level so the array identity is stable across renders. */
const SNAP_POINTS = ['42%'];

export const ReportSheet = forwardRef<BottomSheet, Props>(function ReportSheet(
  { onAction },
  ref,
) {
  const insets = useSafeAreaInsets();

  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />
    ),
    [],
  );

  return (
    <BottomSheet
      ref={ref}
      index={-1}
      snapPoints={SNAP_POINTS}
      // enableDynamicSizing defaults to TRUE in v5: with a BottomSheetView the
      // sheet measures its content on mount and settles at that height BEFORE
      // honouring index={-1}, which is why it appeared half-open on every
      // reload without anyone touching the camera button. Explicit snap points
      // make dynamic sizing redundant anyway.
      enableDynamicSizing={false}
      animateOnMount={false}
      enablePanDownToClose
      backdropComponent={backdrop}
      handleIndicatorStyle={{ backgroundColor: '#9db5a7' }}
      backgroundStyle={{ backgroundColor: '#ffffff', borderRadius: 24 }}
    >
      <BottomSheetView style={{ paddingBottom: insets.bottom + 12 }}>
        <Text className="px-5 pb-1 pt-1 text-lg font-bold text-hawk-ink">Report</Text>
        <Text className="px-5 pb-3 text-sm text-neutral-500">
          Every report is signed, hash-chained and publicly verifiable.
        </Text>
        {ACTIONS.map((a) => (
          <Pressable
            key={a.key}
            className="mx-4 mb-2 flex-row items-center rounded-2xl bg-hawk-mist px-4 py-3 active:opacity-70"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onAction(a.key);
            }}
          >
            <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-hawk-green">
              <Feather name={a.icon} size={18} color={BRAND.gold} />
            </View>
            <View className="flex-1">
              <Text className="text-base font-semibold text-hawk-ink">{a.label}</Text>
              <Text className="text-xs text-neutral-500">{a.sub}</Text>
            </View>
            <Feather name="chevron-right" size={18} color="#9db5a7" />
          </Pressable>
        ))}
      </BottomSheetView>
    </BottomSheet>
  );
});
