import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { type ReactNode } from 'react';
import { Animated, Image, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HEADER_CONTENT_H } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';

/**
 * Shared top pane for native screens — the native twin of the web's .gov-header:
 * the hawkeye mark (tap -> Home) on the left, the screen title, and a right
 * action (close/back, or the menu). Absolutely positioned and driven by
 * useHideOnScroll's translateY, so the row slides away on scroll-down and
 * returns on scroll-up. Screens pad their scroll content by the hook's headerH so
 * nothing starts underneath it.
 *
 * TWO PIECES, AND ONLY ONE OF THEM MOVES. The status-bar inset is an opaque
 * strip pinned at the top; the row slides underneath it.
 *
 * It used to be one pane — inset padding and row together — translated as a
 * unit. Scrolling down therefore carried the mark and the title UP THROUGH the
 * status bar, where they overlapped the clock and the carrier text with nothing
 * opaque behind them, because the pane's own background had moved up too. It
 * looked like the header was drawing over the system UI; it was the header
 * leaving, in full view. Splitting them means the row disappears BEHIND the
 * strip, which is what every iOS app does and what the animation always meant.
 *
 * The strip therefore sits above the row in z-order. Both stay above content.
 */
export function ScreenHeader({
  title,
  translateY,
  onClose,
  right,
  rightSlot,
}: {
  title: string;
  /** Omit for a static (non-hiding) header — e.g. a chat screen, where a header
   *  that slid away mid-read would be wrong. When set, drive it from
   *  useHideOnScroll's translateY so the pane hides on scroll-down. */
  translateY?: Animated.AnimatedInterpolation<number>;
  onClose?: () => void;
  right?: 'close' | 'menu' | 'none';
  /** Custom content beside the title (e.g. a StatusChip), before the close/menu. */
  rightSlot?: ReactNode;
}) {
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const rightKind = right ?? (onClose ? 'close' : 'none');
  return (
    <>
      {/* The pinned strip. Never translates, so there is always something opaque
          between the sliding row and the system clock. */}
      <View
        className="bg-surface"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top, zIndex: 11 }}
      />
      <Animated.View
        className="border-b border-line bg-surface"
        style={{
          position: 'absolute',
          top: insets.top,
          left: 0,
          right: 0,
          zIndex: 10,
          transform: translateY ? [{ translateY }] : [],
        }}
      >
        <View className="flex-row items-center px-4" style={{ height: HEADER_CONTENT_H }}>
          <Pressable
            onPress={() => router.navigate('/(tabs)' as never)}
            hitSlop={8}
            className="mr-3"
            accessibilityRole="button"
            accessibilityLabel="Home"
          >
            <Image
              source={require('@/assets/images/icon.png')}
              style={{ width: 30, height: 30, borderRadius: 8 }}
            />
          </Pressable>
          <Text className="flex-1 text-xl font-bold text-ink" numberOfLines={1}>
            {title}
          </Text>
          {rightSlot ? <View className="mr-2">{rightSlot}</View> : null}
          {rightKind === 'close' ? (
            <Pressable
              onPress={onClose ?? (() => router.back())}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Feather name="x" size={24} color={ui.ink} />
            </Pressable>
          ) : rightKind === 'menu' ? (
            <Pressable
              onPress={() => router.navigate('/(tabs)/more' as never)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Menu"
            >
              <Feather name="menu" size={24} color={ui.ink} />
            </Pressable>
          ) : null}
        </View>
      </Animated.View>
    </>
  );
}
