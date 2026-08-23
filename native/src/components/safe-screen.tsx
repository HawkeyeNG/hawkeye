import { type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTopInset } from '@/lib/safe-area';

/**
 * SafeAreaView, except the TOP inset cannot be zero for a frame.
 *
 * safe-area-context's SafeAreaView takes every inset from the provider, and the
 * provider starts at zero and fills in once the native side reports back. A
 * screen mounting in that window paints its header at y = 0, over the status
 * bar, and then jumps down. It bites hardest on the report wizard: that screen
 * is a fullScreenModal, so it gets its own window and the measurement happens
 * again at presentation, and it is heavy enough that the zero-inset frame lasts
 * long enough to see and photograph.
 *
 * The obvious fix — `initialMetrics` on a SafeAreaProvider — was tried in build
 * 5 and made things worse: expo-router already renders a provider, and a nested
 * second one measures its own frame, which inside a modal excludes the status
 * bar and so reports zero FOREVER. See the note in app/_layout.tsx.
 *
 * So the top comes from useTopInset(), which falls back to the window metrics
 * captured at startup only while the measured value is still zero. The other
 * three edges keep reading the provider directly: a zero bottom or side inset
 * for one frame is invisible, and only the top overlaps system chrome.
 *
 * Screens that draw their own header through ScreenHeader do not need this —
 * that component already uses useTopInset. This is for screens that rely on a
 * container to inset them, which is the whole report flow.
 */
export function SafeScreen({
  className,
  style,
  children,
}: {
  className?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const top = useTopInset();
  const insets = useSafeAreaInsets();
  return (
    <View
      className={className}
      style={[
        {
          paddingTop: top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
