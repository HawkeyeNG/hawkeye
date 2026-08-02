/**
 * The app's colour scheme — the user's Light / Dark / System preference already
 * resolved, NOT the raw OS value.
 *
 * This used to re-export react-native's `useColorScheme` directly, which meant
 * every consumer (themed-text, themed-view, ui/collapsible via use-theme) was
 * hard-wired to the OS and could not be overridden. Both platform variants of
 * this file now delegate to src/lib/theme-pref.tsx, so there is exactly one
 * answer to "which theme is on" across the app.
 */
export { useResolvedColorScheme as useColorScheme } from '@/lib/theme-pref';
