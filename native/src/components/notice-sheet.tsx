import { useState } from 'react';
import { InteractionManager } from 'react-native';

import { ConfirmSheet } from '@/components/confirm-sheet';

/**
 * A one-action notice in the app's own sheet, replacing `Alert.alert`.
 *
 * WHY THIS EXISTS. Every `Alert.alert` in this app was a single-button notice —
 * "this failed, here is why" — with no button array and no callback. React
 * Native hands those to the OS, so Android drew its grey Material dialog: the
 * one surface in the product that stopped looking like Hawkeye, and it appeared
 * exactly when something had gone wrong.
 *
 * WHY A HOOK RATHER THAN A COMPONENT PER CALL SITE. There are 21 of these
 * across nine files. Giving each its own `useState` and its own sheet is 21
 * chances to forget the dismiss handler or leave the sheet mounted. `useNotice`
 * owns the state, so a file adds three lines however many notices it raises.
 *
 *   const notice = useNotice();
 *   notice.show('Could not refresh', `Your alerts did not load. (${failed})`);
 *   <NoticeSheet {...notice.props} />
 *
 * TONE, NOT DANGER. Failures here are "that did not work", not destructive
 * acts, so they wear the green and gold rather than the red — `danger` on
 * ConfirmSheet is reserved for things like deleting an identity. `good` is for
 * the one genuine success notice.
 */
type Tone = 'fail' | 'good';

export type Notice = { title: string; body: string; tone: Tone } | null;

export function useNotice() {
  const [notice, setNotice] = useState<Notice>(null);
  return {
    /**
     * Raise a notice. Tone defaults to 'fail' — almost all of these are.
     *
     * DEFERRED UNTIL ANIMATIONS SETTLE, and that is not fussiness. This sheet
     * is a react-native `Modal`, and callers routinely close one modal and
     * raise a notice in the same handler — `profile.tsx` does exactly that on
     * the "Password saved" path. React batches both into one commit, so the
     * outgoing modal unmounts in the very frame this one mounts, and iOS
     * silently swallows the incoming presentation: the notice never appears.
     *
     * `Alert.alert` never had this problem, because an OS dialog sits outside
     * RN's modal stack entirely. Replacing it with an in-app sheet imports the
     * constraint, so the fix belongs here, once, rather than in every caller
     * that happens to close something first.
     */
    show: (title: string, body: string, tone: Tone = 'fail') => {
      InteractionManager.runAfterInteractions(() => setNotice({ title, body, tone }));
    },
    dismiss: () => setNotice(null),
    props: { notice, onDismiss: () => setNotice(null) },
  };
}

export function NoticeSheet({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: () => void;
}) {
  return (
    <ConfirmSheet
      visible={!!notice}
      icon={notice?.tone === 'good' ? 'check-circle' : 'alert-circle'}
      title={notice?.title ?? ''}
      body={notice?.body ?? ''}
      confirmLabel="OK"
      /* A notice has nothing to cancel — one way out, not two. */
      cancelLabel={null}
      onConfirm={onDismiss}
      onCancel={onDismiss}
    />
  );
}
