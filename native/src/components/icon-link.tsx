import { Feather } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { useUi } from '@/lib/theme';

/**
 * A link marked by an ICON rather than a rule under the words.
 *
 * THE THIRD ANSWER TO THE SAME PROBLEM, and the one that should have been
 * first. iOS draws textDecorationLine tight to the baseline, where descenders
 * cross it and break it into pieces — the g in "nigeria", the g in "org". So
 * the rules were redrawn as a border below the line box, which no glyph could
 * reach. That worked, and looked wrong: below a 12px word in a 20px line box
 * the border sits far enough away to read as a stray line rather than an
 * underline.
 *
 * An icon avoids the argument entirely. It says "this opens something" more
 * plainly than a rule does, it distinguishes an external site (external-link)
 * from an in-app panel (chevron-right), and there is nothing about it for a
 * text renderer to get wrong on either platform.
 *
 * The colour is applied as a STYLE, not a class, so the label and its glyph
 * cannot drift apart: className carries size and weight only.
 */
export function IconLink({
  label,
  icon = 'external-link',
  onPress,
  className = 'text-sm font-bold',
  color,
  size = 13,
}: {
  label: string;
  /** external-link for another site, chevron-right for something in-app. */
  icon?: 'external-link' | 'chevron-right' | 'info';
  /** Omit when a parent Pressable already handles the tap — nesting a second
   *  pressable inside one competes for the touch. */
  onPress?: () => void;
  /** Size and weight only; the colour comes from `color`. */
  className?: string;
  color?: string;
  size?: number;
}) {
  const ui = useUi();
  const tint = color ?? ui.tint.good.ink;
  const body = (
    <View className="flex-row items-center">
      <Text className={className} style={{ color: tint }}>
        {label}
      </Text>
      <Feather name={icon} size={size} color={tint} style={{ marginLeft: 4 }} />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="link">
      {body}
    </Pressable>
  );
}
