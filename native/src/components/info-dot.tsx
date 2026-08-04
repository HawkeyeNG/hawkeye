import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { useUi } from '@/lib/theme';

/**
 * The ⓘ that replaces a paragraph. Native twin of the web's `.info-i`
 * (app/menu.js).
 *
 * Explanatory prose was the single biggest consumer of vertical space on these
 * screens, and almost none of it is read twice. Anything that EXPLAINS becomes a
 * dot beside the thing it explains; anything that INSTRUCTS mid-flow (which
 * photo to take, what to type) stays visible — those are not explanations.
 *
 *   <Text className="…">Automated checks on every result.<InfoDot title="What gets checked" text="…" /></Text>
 *
 * Renders inline inside a <Text> as well as standalone.
 */
export function InfoDot({ title, text }: { title?: string; text: string }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={title ? `More information: ${title}` : 'More information'}
        // Padding rather than size: keeps the tap target honest without pushing
        // the line it sits on around.
        hitSlop={10}
        className="px-1"
      >
        <View
          className="h-5 w-5 items-center justify-center rounded-full border"
          style={{ borderColor: ui.tint.good.ink }}
        >
          <Text className="text-[11px] font-bold" style={{ color: ui.tint.good.ink }}>
            i
          </Text>
        </View>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* Backdrop closes; the inner Pressable swallows the tap so the card stays. */}
        <Pressable
          onPress={() => setOpen(false)}
          className="flex-1 items-center justify-center bg-black/50 px-6"
        >
          <Pressable onPress={() => {}} className="w-full max-w-md rounded-2xl bg-card p-5">
            {title ? <Text className="pb-2 text-lg font-bold text-ink">{title}</Text> : null}
            <ScrollView className="max-h-96">
              <Text className="text-sm leading-5 text-ink">{text}</Text>
            </ScrollView>
            <Pressable onPress={() => setOpen(false)} className="mt-4 rounded-full bg-good py-3">
              <Text className="text-center text-sm font-bold text-good-ink">Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
