import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

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
  title,
  children,
  footer,
  closeLabel = 'Close',
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Replaces the default Close button when a modal needs its own actions. */
  footer?: ReactNode;
  closeLabel?: string;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Backdrop closes; the inner Pressable swallows the tap so the card stays. */}
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-black/50 px-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md rounded-2xl bg-card p-5"
          style={{ maxHeight: '85%' }}
        >
          {title ? <Text className="pb-2 text-lg font-bold text-ink">{title}</Text> : null}
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
