/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme() {
  // Already narrowed to 'light' | 'dark' and already carrying the user's
  // override — no 'unspecified' / null branch to defend against any more.
  return Colors[useColorScheme()];
}
