import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ModalCard } from '@/components/modal-card';
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

      {/* The card and its scrolling now come from ModalCard. The fixed
          `max-h-96` this used to carry is exactly what cut the docket's
          explanation off mid-sentence on a long dot. */}
      <ModalCard visible={open} onClose={() => setOpen(false)} title={title}>
        <Text className="text-sm leading-5 text-ink">{text}</Text>
      </ModalCard>
    </>
  );
}
