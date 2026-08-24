import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The bar that holds a screen's primary action, pinned to the bottom.
 *
 * THE RULE IT ENFORCES: no primary or committing action is ever reachable only
 * by scrolling. Report a Result and Map a Polling Unit already did this by hand,
 * each with its own copy of the same four classes and its own inset arithmetic;
 * this is that pattern named once so the next screen cannot get it subtly wrong.
 *
 * TWO INVARIANTS, and they only work together:
 *
 *  - IT MUST BE A SIBLING OF THE SCROLLER, never a child. Inside a ScrollView it
 *    scrolls, which is the whole problem. This component cannot enforce that —
 *    the host has to place it — so it is said here and in every call site.
 *  - IT PAYS THE SAFE-AREA INSET ITSELF. A footer flush with the bottom of the
 *    display sits under the home indicator on an iPhone and under the gesture
 *    bar on Android, where a tap either does nothing or leaves the app. The
 *    inset is read from the provider rather than hardcoded, because it differs
 *    per device and changes on rotation.
 *
 * `bg-surface` and the top border are what separate it from the content sliding
 * underneath; without them a pinned bar reads as part of whatever it is
 * currently covering.
 */
export function PinnedFooter({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="border-t border-line bg-surface px-4 pt-3"
      style={{ paddingBottom: insets.bottom + 12 }}
    >
      {children}
    </View>
  );
}
