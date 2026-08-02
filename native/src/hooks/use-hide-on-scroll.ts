import { useMemo, useRef } from 'react';
import { Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Height of the header row under the status-bar inset. Shared with ScreenHeader
 *  so the value the content pads by always matches the value the header renders. */
export const HEADER_CONTENT_H = 52;

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
  const insets = useSafeAreaInsets();
  const headerH = insets.top + HEADER_CONTENT_H;
  const scrollY = useRef(new Animated.Value(0)).current;
  const { translateY, onScroll } = useMemo(
    () => ({
      translateY: Animated.diffClamp(scrollY, 0, headerH).interpolate({
        inputRange: [0, headerH],
        outputRange: [0, -headerH],
        extrapolate: 'clamp',
      }),
      onScroll: Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
      }),
    }),
    [scrollY, headerH],
  );
  return { translateY, onScroll, headerH, scrollEventThrottle: 16 };
}
