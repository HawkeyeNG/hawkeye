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
 * PUT IT IN A ROW, NOT INSIDE THE <Text>:
 *
 *   <View className="flex-row items-center">
 *     <Text className="flex-1 …">Automated checks on every result.</Text>
 *     <InfoDot title="What gets checked" text="…" />
 *   </View>
 *
 * This docblock used to show the dot nested inside the <Text>, and said it
 * "renders inline inside a <Text> as well as standalone". It does not, reliably:
 * Android lays an embedded view out inline and can clip the surrounding text.
 * The incident flow's "The unit you are AT…" line shipped truncated mid-sentence
 * with the dot sitting over the remainder, and it was the only caller following
 * this example — every other one is already a flex row. `flex-1` on the Text is
 * what lets the copy wrap instead of pushing the dot off the edge.
 */
export function InfoDot({
  title,
  text,
  color,
}: {
  title?: string;
  text: string;
  /**
   * Ink for the dot itself, when it does not sit on a normal surface. The
   * default good-ink is a green tuned for `bg-surface`/`bg-card`; on the
   * docket's amber `bg-warn` banner it is close to unreadable. Callers on a
   * coloured card pass that card's own ink.
   */
  color?: string;
}) {
  const ui = useUi();
  const dotColor = color ?? ui.tint.good.ink;
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
          style={{ borderColor: dotColor }}
        >
          <Text className="text-[11px] font-bold" style={{ color: dotColor }}>
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
