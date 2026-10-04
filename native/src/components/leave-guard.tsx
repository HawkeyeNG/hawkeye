import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useRef, useState, type ReactElement } from 'react';

import { ConfirmSheet } from '@/components/confirm-sheet';
import { t as i18nT } from '@/lib/i18n';

/**
 * "Discard this report?" before a report in progress is left.
 *
 * Flow walkthrough REP-RES-01: the header ×, the crest and Android's Back all
 * left a report at once — two photos, the unit and the race gone, nothing
 * asked. Two ways in, one sheet:
 *
 *  - usePreventRemove intercepts every exit that REMOVES the screen through
 *    the stack: router.back() (the ×, the camera's Cancel), the hardware Back
 *    the native stack turns into a goBack, and the iOS swipe, which it disables
 *    while active.
 *  - `confirmLeave(go)` is for an exit that does not reach the stack as a
 *    removal. The crest's router.navigate('/(tabs)') is one: measured on the
 *    web build, it left the report without beforeRemove ever firing, while
 *    router.back() from the same screen was intercepted. So the crest asks
 *    through this instead of trusting the router to.
 *
 * The question is the app's own sheet, never a system Alert.
 *
 * `active` is the host's rule for "there is something to lose" (a photo taken
 * and the report not yet handed off). `onDiscard` runs before the exit
 * proceeds — the place to delete a kept draft. `onKeep` runs when the observer
 * stays: a host whose exit came from CaptureCamera's Cancel must remount the
 * camera there, because Cancel has already marked that instance cancelled and
 * it would ignore every later shutter press.
 *
 * The host renders `sheet` in EVERY branch it can be asked from — the camera
 * steps included.
 */
export function useLeaveGuard(
  active: boolean,
  onDiscard?: () => void,
  onKeep?: () => void,
): { sheet: ReactElement; confirmLeave: (go: () => void) => void } {
  const navigation = useNavigation();
  type Pending = { action?: Parameters<typeof navigation.dispatch>[0]; go?: () => void };
  const [pending, setPending] = useState<Pending | null>(null);
  /** Set once Discard is chosen, so the exit it starts is not asked about again. */
  const leaving = useRef(false);

  usePreventRemove(active, ({ data }) => {
    if (leaving.current) {
      // Out of the listener first: dispatching from inside the very event that
      // is being emitted for it is re-entrant.
      setTimeout(() => navigation.dispatch(data.action), 0);
      return;
    }
    setPending({ action: data.action });
  });

  const confirmLeave = (go: () => void) => {
    if (!active || leaving.current) go();
    else setPending({ go });
  };

  const sheet = (
    <ConfirmSheet
      visible={!!pending}
      icon="trash-2"
      title={i18nT('n.components.leave-guard.title')}
      body={i18nT('n.components.leave-guard.body')}
      confirmLabel={i18nT('n.components.leave-guard.discard')}
      cancelLabel={i18nT('n.components.leave-guard.keep')}
      danger
      onConfirm={() => {
        const p = pending;
        setPending(null);
        leaving.current = true;
        onDiscard?.();
        // Re-dispatching the intercepted action is the documented way through:
        // React Navigation does not ask this screen a second time for it.
        if (p?.action) navigation.dispatch(p.action);
        else p?.go?.();
      }}
      onCancel={() => {
        setPending(null);
        onKeep?.();
      }}
    />
  );
  return { sheet, confirmLeave };
}
