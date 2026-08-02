/**
 * Web variant — deliberately identical to the native one now.
 *
 * It used to hold a hydration guard that returned 'light' until the first
 * effect ran, so a statically rendered page did not claim a scheme the server
 * could not know. That guard has moved up to `ThemePrefProvider`, which holds
 * the first themed paint until the stored preference has been read (a
 * client-only step by definition) — so the guard here would only add a second,
 * conflicting source of truth. See src/lib/theme-pref.tsx.
 */
export { useResolvedColorScheme as useColorScheme } from '@/lib/theme-pref';
