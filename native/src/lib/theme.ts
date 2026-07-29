import { useColorScheme } from 'react-native';

/**
 * Colours for props that cannot take a className — icon tints, mostly.
 *
 * The class-level palette lives in global.css as CSS variables; this mirrors
 * the two values that must follow the theme in JS. Keep them in step: `ink` and
 * `faint` here are the same colours as --ink and --faint there.
 */
export function useUi() {
  const dark = useColorScheme() === 'dark';
  return {
    dark,
    /** Primary icon tint — near-black on light, near-white on dark. */
    ink: dark ? '#e8f2ec' : '#10221a',
    /** Chevrons, dividers, anything deliberately quiet. */
    faint: dark ? '#6e8076' : '#9db5a7',
  };
}
