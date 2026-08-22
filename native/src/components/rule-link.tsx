import { Pressable, Text, View } from 'react-native';

import { useUi } from '@/lib/theme';

/**
 * A link with a rule under it, drawn as a BORDER rather than textDecorationLine.
 *
 * WHY NOT JUST UNDERLINE. iOS draws textDecorationLine tight to the baseline,
 * and every descender — the g in "nigeria", the g in "org" — crosses it and
 * punches a hole. The result is a rule that looks broken into pieces, which is
 * exactly what it is. There is no React Native API for underline offset or
 * thickness, so the effect cannot be tuned away; the rule has to be moved out
 * of the glyphs' path, and the only way to do that is to stop asking the text
 * renderer for it.
 *
 * A border on the wrapping View sits below the whole line box, so descenders
 * are already above it and nothing can interrupt it. `self-start` keeps the
 * rule the width of the word rather than the width of the row.
 *
 * This only works for a link that stands on its own. A link INSIDE a flowing
 * sentence is a nested Text and cannot carry a View, so those keep
 * textDecorationLine and need generous leading instead — see gov-disclaimer.
 */
export function RuleLink({
  label,
  onPress,
  className = 'text-sm font-bold leading-6',
}: {
  label: string;
  onPress: () => void;
  /** Type styles for the label. The colour comes from the theme's link tone. */
  className?: string;
}) {
  const ui = useUi();
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="link">
      <View
        className="self-start"
        style={{ borderBottomWidth: 1, borderBottomColor: ui.tint.good.ink, paddingBottom: 1 }}
      >
        <Text className={`${className} text-good-ink`}>{label}</Text>
      </View>
    </Pressable>
  );
}
