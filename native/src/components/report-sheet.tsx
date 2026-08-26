import BottomSheet, { BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { forwardRef, useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Feather } from '@expo/vector-icons';
import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';

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
  const ui = useUi();
  const insets = useSafeAreaInsets();
  /**
   * IS THE SHEET ACTUALLY OPEN?
   *
   * Not cosmetic — it decides whether the backdrop exists at all. See below.
   */
  const [open, setOpen] = useState(false);

  /**
   * THE BACKDROP IS UNMOUNTED WHEN CLOSED, NOT JUST FADED.
   *
   * BottomSheetBackdrop animates its opacity between appearsOnIndex and
   * disappearsOnIndex, but it stays MOUNTED across the whole range and keeps
   * pointerEvents: 'auto'. If that close animation is ever interrupted — a
   * navigation away mid-gesture, a Fast Refresh, a re-render that resets the
   * animated value — it can settle at opacity 0 while still swallowing every
   * touch. The screen then looks completely normal and is completely dead,
   * except for anything in its own window: the dev-client gear, and any
   * floating control drawn above it. That is precisely how this was reported,
   * and it is intermittent because it depends on an animation being cut short.
   *
   * Gating the whole component on the sheet's real index makes the failure
   * impossible rather than unlikely: when the sheet is closed there is no
   * backdrop in the tree to capture anything.
   *
   * pressBehavior="close" as well, so that a backdrop which IS up always has a
   * working way out — the previous one did nothing when tapped.
   */
  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
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
      // index >= 0 means open. onChange fires for every settle, including the
      // one that lands on -1, so the backdrop is torn down as the sheet closes.
      onChange={(i) => setOpen(i >= 0)}
      // undefined, not null: the prop types as FC | undefined, and passing null
      // is the difference between "no backdrop" and a type error.
      backdropComponent={open ? backdrop : undefined}
      // @gorhom/bottom-sheet styles through objects, not classNames, so the
      // theme has to be read in JS. A hardcoded white here left the sheet pale
      // in dark mode while its title (text-ink) went near-white on top of it —
      // an invisible "Report" heading. The handle follows too: a light grab bar
      // on a light sheet is just as lost as a dark one on a dark sheet.
      handleIndicatorStyle={{ backgroundColor: ui.faint }}
      backgroundStyle={{ backgroundColor: ui.card, borderRadius: 24 }}
    >
      <BottomSheetView style={{ paddingBottom: insets.bottom + 12 }}>
        <Text className="px-5 pb-1 pt-1 text-lg font-bold text-ink">Report</Text>
        <Text className="px-5 pb-3 text-sm text-muted">
          Every report is signed, hash-chained and publicly verifiable.
        </Text>
        {ACTIONS.map((a) => (
          <Pressable
            key={a.key}
            className="mx-4 mb-2 flex-row items-center rounded-2xl bg-surface px-4 py-3 active:opacity-70"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onAction(a.key);
            }}
          >
            <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-hawk-green">
              <Feather name={a.icon} size={18} color={BRAND.gold} />
            </View>
            <View className="flex-1">
              <Text className="text-base font-semibold text-ink">{a.label}</Text>
              <Text className="text-xs text-muted">{a.sub}</Text>
            </View>
            <Feather name="chevron-right" size={18} color={ui.faint} />
          </Pressable>
        ))}
      </BottomSheetView>
    </BottomSheet>
  );
});
