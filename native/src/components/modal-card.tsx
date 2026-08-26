import { Feather } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { useUi } from '@/lib/theme';

/**
 * A centred modal whose BODY SCROLLS and whose actions stay put.
 *
 * Every explanatory modal in the app was the same hand-rolled card, and each got
 * the height wrong in its own way. The docket's "How the docket works" ran to
 * four paragraphs and simply CUT OFF mid-sentence — the reader could not reach
 * the rest, and nothing on screen said there was more.
 *
 * Two rules, and they have to hold together:
 *
 *  - THE CARD IS CAPPED AS A FRACTION OF THE SCREEN, never a fixed pixel height.
 *    InfoDot capped its scroll area at 384px, which is both too small on a tall
 *    phone (needless scrolling with the screen half empty) and too large on a
 *    short one (the Close button pushed off the bottom).
 *  - THE FOOTER IS A SIBLING OF THE SCROLL AREA, not inside it. A primary action
 *    reachable only by scrolling is the rule this codebase already broke once;
 *    Close must be on screen from the moment the modal opens.
 */
export function ModalCard({
  visible,
  onClose,
  onCloseIcon,
  dismissOnBackdrop = true,
  title,
  children,
  footer,
  closeLabel = 'Close',
  bottomGap = 0,
}: {
  visible: boolean;
  onClose: () => void;
  /** Renders a close cross beside the title. Give it when the backdrop does not dismiss. */
  onCloseIcon?: () => void;
  /**
   * Whether a tap on the dimmed area closes. TRUE is right for most sheets and
   * WRONG for anything a reader can lose progress in: an outside tap is the
   * easiest gesture to make by accident.
   */
  dismissOnBackdrop?: boolean;
  title?: string;
  children: ReactNode;
  /** Replaces the default Close button when a modal needs its own actions. */
  footer?: ReactNode;
  closeLabel?: string;
  /**
   * Leave this many pixels at the foot of the screen UNCOVERED — no scrim, no
   * touch capture.
   *
   * For the tour, which talks about the tab bar. An RN Modal is a separate
   * native window above the whole React root, so the bar renders underneath and
   * a full-bleed backdrop dims it to the same grey as everything else — which
   * is the opposite of pointing at it. Cutting the scrim short lets the real bar
   * show through at full brightness, so the tab being described is lit rather
   * than merely less dark.
   *
   * Default 0: every other caller keeps today's full-bleed behaviour exactly.
   */
  bottomGap?: number;
}) {
  const ui = useUi();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Backdrop closes; the inner Pressable swallows the tap so the card stays. */}
      <Pressable
        onPress={dismissOnBackdrop ? onClose : undefined}
        className="flex-1 items-center justify-center bg-black/50 px-6"
        style={bottomGap ? { marginBottom: bottomGap } : undefined}
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md rounded-2xl bg-card p-5"
          style={{ maxHeight: '85%' }}
        >
          {title || onCloseIcon ? (
            <View className="flex-row items-start pb-2">
              <Text className="flex-1 text-lg font-bold text-ink">{title}</Text>
              {onCloseIcon ? (
                <Pressable
                  onPress={onCloseIcon}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  className="-mr-1 -mt-1 rounded-full p-1 active:opacity-60"
                >
                  <Feather name="x" size={20} color={ui.muted} />
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {/* flexShrink lets the scroll area give up space to the title and
              footer; without it the content pushes them off a short screen. */}
          <ScrollView style={{ flexShrink: 1 }} persistentScrollbar>
            {children}
          </ScrollView>
          <View className="pt-4">
            {footer ?? (
              <Pressable onPress={onClose} className="rounded-full bg-good py-3">
                <Text className="text-center text-sm font-bold text-good-ink">{closeLabel}</Text>
              </Pressable>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
