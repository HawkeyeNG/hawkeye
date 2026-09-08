import { Text, type TextProps } from 'react-native';

/**
 * THE LABEL INSIDE A BUTTON. One component, because there was none.
 *
 * Every button in this app is an ad-hoc Pressable with a Text inside it, and
 * each one made its own decisions about wrapping and alignment. In English that
 * is invisible: the copy is short and fits on one line whatever you do. In
 * Hausa it is not — the same strings run roughly 40% longer, and the app shipped
 * with "Browse the register instead" broken across three ragged left-aligned
 * lines, and the pinned "Kai rahoto daga rukuninka" across two, beside a
 * one-line button of the same height.
 *
 * WHAT THIS FIXES, and why each part is needed:
 *
 *  - CENTRED. A wrapped label that is left-aligned reads as a paragraph that
 *    happens to be on a button. Centred, two lines still read as a label.
 *  - CLAMPED. `numberOfLines` stops a long translation from growing the control
 *    and pushing the layout around it — which matters most in the pinned footer
 *    and in the report sheet, whose snap point is a fixed height.
 *  - SHRINKS BEFORE IT CLIPS. `adjustsFontSizeToFit` trades a little size for
 *    fitting, down to `minimumFontScale`. Truncating a button label with an
 *    ellipsis is the one outcome worse than a small one: "Kai rahoto daga…"
 *    does not tell anyone what the button does.
 *
 * THE FLOOR IS DELIBERATE. 0.8 keeps a 16px label at ~13px, which is still
 * above the smallest type used elsewhere in the app. Going lower would let a
 * genuinely over-long string shrink into unreadability rather than surfacing
 * that the string needs rewriting — the label should get shorter, not smaller,
 * and a translation that hits this floor is a translation to reconsider.
 *
 * WHAT IT IS NOT FOR: headings, body copy, list rows, or anything that is
 * legitimately a paragraph. Those wrap left-aligned on purpose. This is only
 * for the text inside a control that is tapped.
 */
export function ButtonText({
  children,
  className = '',
  numberOfLines = 2,
  minimumFontScale = 0.8,
  ...rest
}: TextProps & { className?: string }) {
  return (
    <Text
      numberOfLines={numberOfLines}
      adjustsFontSizeToFit
      minimumFontScale={minimumFontScale}
      // `text-center` first so a caller can still override alignment for the
      // rare label that is deliberately leading-aligned beside an icon.
      className={`text-center ${className}`}
      {...rest}
    >
      {children}
    </Text>
  );
}
