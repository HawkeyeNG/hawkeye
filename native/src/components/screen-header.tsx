import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTopInset } from '@/lib/safe-area';

import { HEADER_CONTENT_H } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';
import { t as i18nT } from '@/lib/i18n';

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
  onHome,
}: {
  title: string;
  /** Replaces the mark's default "navigate to the tabs". For a screen that must
   *  LEAVE rather than stack the tabs on top of itself — the sign-up chooser,
   *  where going home means skipping and must not leave the chooser behind. */
  onHome?: () => void;
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
  // Falls back to the startup window metrics while the measured value is
  // still zero, so the row never paints over the clock on a first mount.
  const topInset = useTopInset();
  const rightKind = right ?? (onClose ? 'close' : 'none');
  /**
   * A TITLE THAT WRAPS, NOT ONE THAT ELLIPSISES. The Igbo titles of How, Guide,
   * About and Ready were cut off with "…" on one line (design audit Oct 2026,
   * X6). Two lines are allowed; once the title has actually wrapped it steps
   * down to 18/22, so two lines (44pt) sit inside the fixed 52pt row. Remembered
   * per title, so a title that fits on one line at the smaller size cannot flip
   * back to 20pt, wrap again and loop. A one-line title stays at 20pt. The 24pt
   * line height on the first pass keeps even an unmeasured two-line title
   * (wherever onTextLayout does not fire) at 48pt, inside the row.
   */
  const [wrapped, setWrapped] = useState<string | null>(null);
  const twoLines = wrapped === title;
  return (
    <>
      {/* The pinned strip. Never translates, so there is always something opaque
          between the sliding row and the system clock. */}
      <View
        className="bg-surface"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topInset, zIndex: 11 }}
      />
      {/* Explicit height, and the hairline on the INNER row.
          With the border on this outer View and no height set, Yoga sized it
          52 + 1 = 53 while the slide travels exactly 52 — so the hairline stopped
          one pixel below the pinned strip and stayed there, drawn over the
          scrolling content, for as long as the header was hidden. Before the
          split the same pixel existed but landed inside the status bar where
          nothing showed it. Pinning the height also makes the headerH callers
          pad by exact rather than one short. */}
      <Animated.View
        className="bg-surface"
        style={{
          position: 'absolute',
          top: topInset,
          left: 0,
          right: 0,
          height: HEADER_CONTENT_H,
          zIndex: 10,
          transform: translateY ? [{ translateY }] : [],
        }}
      >
        <View
          className="flex-row items-center border-b border-line px-4"
          style={{ height: HEADER_CONTENT_H }}
        >
          {/* 44pt TARGETS, SAME PICTURE. The mark is 32pt and the close glyph
              24pt; padding grows each Pressable's own box to 44 and an equal
              negative margin gives the space back, so nothing on screen moves
              (hitSlop alone left the measured boxes at 32x32 and 24x26). */}
          <Pressable
            onPress={onHome ?? (() => router.navigate('/(tabs)' as never))}
            style={styles.home}
            accessibilityRole="button"
            accessibilityLabel={i18nT('nav.home')}
          >
            {/* THE TRANSPARENT MARK, not the launcher icon. icon.png is the
                store icon — the hawk on its own green tile — so the header drew
                a tile inside a bar that is already that colour, and the app
                looked unlike Lite for no reason anyone chose. Lite swaps in
                logo-crest.svg for exactly this; crest.png is that same artwork.
                No borderRadius: there is no plate left to round. */}
            <Image
              source={require('@/assets/images/crest.png')}
              style={{ width: 32, height: 32 }}
            />
          </Pressable>
          <Text
            className={`flex-1 font-bold text-ink ${twoLines ? 'text-lg' : 'text-xl'}`}
            style={{ lineHeight: twoLines ? 22 : 24 }}
            numberOfLines={2}
            // Two 22pt lines at 1.15x still fit the 52pt row; past that the row
            // would clip them. A one-line title keeps the reader's full scale.
            maxFontSizeMultiplier={twoLines ? 1.15 : undefined}
            onTextLayout={(e) => {
              if (!twoLines && e.nativeEvent.lines.length > 1) setWrapped(title);
            }}
          >
            {title}
          </Text>
          {rightSlot ? <View className="mr-2">{rightSlot}</View> : null}
          {rightKind === 'close' ? (
            <Pressable
              onPress={onClose ?? (() => router.back())}
              style={styles.action}
              accessibilityRole="button"
              accessibilityLabel={i18nT('common.close')}
            >
              <Feather name="x" size={24} color={ui.ink} />
            </Pressable>
          ) : rightKind === 'menu' ? (
            <Pressable
              onPress={() => router.navigate('/(tabs)/more' as never)}
              style={styles.action}
              accessibilityRole="button"
              accessibilityLabel={i18nT('common.menu')}
            >
              <Feather name="menu" size={24} color={ui.ink} />
            </Pressable>
          ) : null}
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  /** 32pt mark + 6pt padding a side = 44. The right margin is the old mr-3 (12)
   *  less the 6 the padding added, so the title starts where it always did. */
  home: { padding: 6, marginVertical: -6, marginLeft: -6, marginRight: 6 },
  /** 24pt glyph + 10pt padding a side = 44 wide (46 tall with the icon font's
   *  line box); the negative margin keeps its footprint at 24. */
  action: { padding: 10, margin: -10 },
});
