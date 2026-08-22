import { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useTopInset } from '@/lib/safe-area';

/** Height of the header row under the status-bar inset. Shared with ScreenHeader
 *  so the value the content pads by always matches the value the header renders. */
export const HEADER_CONTENT_H = 52;

/**
 * OVERSCROLL HAS TO BE CLAMPED OUT, OR iOS BOUNCE DRIVES THE HEADER.
 *
 * diffClamp reacts to CHANGES in scroll offset, and it cannot tell a real drag
 * from a rubber band. On iOS both ends bounce, so:
 *
 *   - At the top, pulling down sends the offset NEGATIVE. Letting go returns it
 *     to 0, which is an increase, which diffClamp reads as scrolling down — so
 *     the header hid itself when the reader was already at the top and had
 *     pulled DOWN. That is the "it disappears if I scroll up again" report.
 *   - At the bottom, the offset overshoots the maximum and springs back. The
 *     spring back is a decrease, read as scrolling up, so the header popped in
 *     on arrival at the end of a page.
 *
 * Android has no rubber band — it paints an edge glow and pins the offset — so
 * neither happened there, which is exactly what was reported.
 *
 * The fix is to feed diffClamp an offset clamped to the real scrollable range,
 * so both bounce regions are flat and produce no delta at all. The maximum
 * comes off the scroll event itself (contentSize - layoutMeasurement), so no
 * screen has to measure or pass anything: the hook's return shape is unchanged
 * and all eighteen callers keep working untouched.
 */
function useScrollRange() {
  const [maxScroll, setMaxScroll] = useState(0);
  const known = useRef(0);
  const note = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentSize, layoutMeasurement } = e.nativeEvent;
    const max = Math.max(0, contentSize.height - layoutMeasurement.height);
    // A pixel of jitter is not a resize; re-rendering on every frame would be.
    if (Math.abs(max - known.current) > 1) {
      known.current = max;
      setMaxScroll(max);
    }
  }, []);
  return { maxScroll, note };
}

/**
 * Clamp an offset to [0, maxScroll] on the native thread.
 *
 * Before the first scroll event maxScroll is still 0, and clamping to [0, 0]
 * would flatten every offset and freeze the header. Until it is known, clamp
 * the bottom end only: negative offsets are always overscroll, whatever the
 * content height turns out to be.
 */
function clampToRange(scrollY: Animated.Value, maxScroll: number) {
  return maxScroll > 0
    ? scrollY.interpolate({
        inputRange: [0, maxScroll],
        outputRange: [0, maxScroll],
        extrapolate: 'clamp',
      })
    : scrollY.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 1],
        extrapolateLeft: 'clamp',
        extrapolateRight: 'extend',
      });
}

/**
 * Scroll-hiding top pane. The header slides up as you scroll DOWN and back as you
 * scroll UP (Animated.diffClamp), the native twin of the web's scroll-hiding
 * .gov-header. Returns:
 *   - translateY: drive the (absolutely positioned) ScreenHeader with it
 *   - onScroll / scrollEventThrottle: attach to an Animated.ScrollView
 *   - headerH: pad the scroll content's top by this so nothing hides under the header
 *
 * Uses react-native Animated with the native driver (same as page.tsx), so the
 * slide runs off the JS thread — smooth even while the list is busy.
 */
export function useHideOnScroll() {
  const headerH = useTopInset() + HEADER_CONTENT_H;
  const scrollY = useRef(new Animated.Value(0)).current;
  const { maxScroll, note } = useScrollRange();
  const { translateY, onScroll } = useMemo(
    () => ({
      // Travel is the ROW's height, not the whole header's. ScreenHeader pins an
      // opaque strip over the status-bar inset and slides only the row beneath
      // it, so the row is fully hidden once it has moved its own height —
      // sliding the full insets.top + row would just push it further behind the
      // strip and make the gesture feel heavier than it needs to be.
      translateY: Animated.diffClamp(
        clampToRange(scrollY, maxScroll),
        0,
        HEADER_CONTENT_H,
      ).interpolate({
        inputRange: [0, HEADER_CONTENT_H],
        outputRange: [0, -HEADER_CONTENT_H],
        extrapolate: 'clamp',
      }),
      // `listener` still runs on the JS thread alongside the native-driven
      // value, which is how the scrollable range is learned without asking any
      // screen to measure itself.
      onScroll: Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
        listener: note,
      }),
    }),
    [scrollY, maxScroll, note],
  );
  return { translateY, onScroll, headerH, scrollEventThrottle: 16 };
}

/**
 * FlashList variant. FlashList routes scroll through its own wrapper and can't
 * feed a native-driver Animated.event, so this drives the SAME diffClamp
 * translateY from a plain JS onScroll callback (the transform runs on the JS
 * thread — fine for a header slide). Same return shape; attach to a FlashList.
 */
export function useHideOnScrollList() {
  const headerH = useTopInset() + HEADER_CONTENT_H;
  const scrollY = useRef(new Animated.Value(0)).current;
  const translateY = useMemo(
    () =>
      // Same as above: the row's height, because only the row moves. No
      // interpolation is needed to clamp here — this path sets the value from
      // JS, so the offset is clamped before it is ever written.
      Animated.diffClamp(scrollY, 0, HEADER_CONTENT_H).interpolate({
        inputRange: [0, HEADER_CONTENT_H],
        outputRange: [0, -HEADER_CONTENT_H],
        extrapolate: 'clamp',
      }),
    [scrollY],
  );
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const max = Math.max(0, contentSize.height - layoutMeasurement.height);
      scrollY.setValue(Math.min(Math.max(contentOffset.y, 0), max));
    },
    [scrollY],
  );
  return { translateY, onScroll, headerH, scrollEventThrottle: 16 };
}
