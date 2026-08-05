import * as Haptics from 'expo-haptics';

/**
 * Haptics, in one place, so a button's feel is not decided by which component
 * someone happened to reuse.
 *
 * That is exactly how the inconsistency arose: accordions built from the shared
 * content-kit pieces (QuestionRow, Fold) buzzed because those components called
 * Haptics themselves, while the hand-rolled ones (integrity's group list,
 * profile's sections) were silent. There was no rule — only an accident of
 * construction.
 *
 * The reporting flows had the mirror-image gap: they fired only on the OUTCOME
 * (submit succeeded / failed), so pressing the button that starts a 40-second
 * upload felt like nothing had happened.
 *
 * Every call swallows its rejection: haptics are unavailable on some devices and
 * under some OS settings, and a buzz failing must never break the action it
 * accompanies.
 */

/** A primary action landed — submit, capture, advance a step. */
export const tap = () => {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
};

/** A selection changed — a row picked, an accordion opened, a filter toggled. */
export const pick = () => {
  Haptics.selectionAsync().catch(() => {});
};

/** The action succeeded. */
export const ok = () => {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
};

/** The action failed. */
export const err = () => {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
};
