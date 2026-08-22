import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The top inset, with a fallback for the frame before it has been measured.
 *
 * safe-area-context starts at zero insets and fills them in once the native
 * side reports back. A screen mounting inside that window paints its header at
 * y = 0 — over the status bar — and then jumps down. It shows worst on screens
 * presented as a fullScreenModal, because a modal gets its own window and the
 * measurement happens again at presentation, so the reader watches it move.
 *
 * The obvious fix — passing `initialMetrics` to a SafeAreaProvider — is a trap
 * here. expo-router already renders a provider above the app, and a nested
 * second one measures its own frame instead of the window: inside a modal that
 * frame excludes the status bar, so it reports zero forever and every header on
 * those screens rides up permanently. That shipped in build 5. See _layout.tsx.
 *
 * So: use the measured value, and only while it is still zero, fall back to the
 * window metrics captured synchronously at startup. Once a real measurement
 * arrives it always wins, so a device that genuinely has no top inset (most
 * Android phones) is unaffected — its measured zero and the fallback agree.
 */
export function useTopInset(): number {
  const insets = useSafeAreaInsets();
  return insets.top || initialWindowMetrics?.insets.top || 0;
}
