import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';

/**
 * theme-pref — the app's Light / Dark / System preference, and the one place
 * that decides which palette is in force.
 *
 * ── Why this file exists ──
 * The app used to read `useColorScheme()` from react-native in three unrelated
 * places (global.css's `prefers-color-scheme` media query, `useUi()` for icon
 * colour PROPS, and react-navigation's ThemeProvider), so the OS was the only
 * input and there was nothing to toggle. Three readers also means three chances
 * to disagree, which is how a screen ends up half-light. Now all three read
 * `scheme` from here.
 *
 * ── Why not NativeWind's colorScheme.set() ──
 * That is the documented manual override, and it does not work as a preference
 * store in this setup:
 *   - On native it delegates to `Appearance.setColorScheme()`. In RN 0.86 that
 *     updates Appearance's cache but emits nothing itself; NativeWind's runtime
 *     only learns the new value if the platform echoes an `appearanceChanged`
 *     event back (on Android via `AppCompatDelegate.setDefaultNightMode` and an
 *     activity configuration change). A preference that depends on a native
 *     round-trip firing is a preference that silently does nothing when it
 *     doesn't.
 *   - On web it throws outright unless `darkMode` is switched to 'class'
 *     (see react-native-css-interop/runtime/web/color-scheme.js).
 *   - It also changes the OS-level appearance for the whole activity, which is
 *     not what "use Light inside this app" should mean.
 * So the preference is plain React state here, persisted in AsyncStorage, and
 * the palette is applied by putting `themeClass(scheme)` on the root View —
 * class-scoped CSS custom properties, which NativeWind resolves identically on
 * native and web. See the long note at the top of src/global.css.
 */

export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedScheme = 'light' | 'dark';

/** AsyncStorage key. Namespaced like the outbox's, so it is greppable. */
export const THEME_PREF_KEY = 'hawkeye.theme.pref';

/**
 * How long to hold the first paint waiting for the stored preference.
 *
 * The read is a single AsyncStorage row and normally lands in a few ms, well
 * inside the native splash — which is the point: paint once, in the right
 * theme, rather than flashing light and correcting itself. But this is a field
 * app, and "the app never got past the splash because a disk read hung" is a
 * far worse failure than one frame of the wrong background, so the gate opens
 * regardless after this long and falls back to `system`.
 */
const READ_TIMEOUT_MS = 1200;

interface ThemePrefState {
  /** What the user chose. 'system' means "follow the OS". */
  pref: ThemePref;
  /** The palette actually in force — 'system' already resolved against the OS. */
  scheme: ResolvedScheme;
  /** False until the stored preference has been read; nothing themed should paint yet. */
  loaded: boolean;
  setPref: (next: ThemePref) => void;
}

const ThemePrefContext = createContext<ThemePrefState | undefined>(undefined);

function isPref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** The Tailwind class carrying that palette's custom properties (src/global.css). */
export function themeClass(scheme: ResolvedScheme): string {
  return scheme === 'dark' ? 'theme-dark' : 'theme-light';
}

export function ThemePrefProvider({ children }: { children: ReactNode }) {
  const system: ResolvedScheme = useSystemColorScheme() === 'dark' ? 'dark' : 'light';
  /** null = the stored preference has not been read yet. */
  const [pref, setPrefState] = useState<ThemePref | null>(null);
  /** Set once the gate has opened, so a late/slow read cannot re-gate the app. */
  const settled = useRef(false);

  useEffect(() => {
    let live = true;
    const settle = (next: ThemePref) => {
      if (!live || settled.current) return;
      settled.current = true;
      setPrefState(next);
    };
    const timer = setTimeout(() => settle('system'), READ_TIMEOUT_MS);
    AsyncStorage.getItem(THEME_PREF_KEY)
      .then((raw) => settle(isPref(raw) ? raw : 'system'))
      .catch(() => settle('system'))
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  const setPref = useCallback((next: ThemePref) => {
    // Apply first, persist second: the UI must not wait on the disk, and a
    // failed write is a forgotten preference, not a broken screen.
    settled.current = true;
    setPrefState(next);
    AsyncStorage.setItem(THEME_PREF_KEY, next).catch(() => {});
  }, []);

  const value = useMemo<ThemePrefState>(
    () => ({
      pref: pref ?? 'system',
      scheme: pref === 'light' || pref === 'dark' ? pref : system,
      loaded: pref !== null,
      setPref,
    }),
    [pref, system, setPref],
  );

  return <ThemePrefContext.Provider value={value}>{children}</ThemePrefContext.Provider>;
}

/**
 * The full preference — for the control in More. Throws outside the provider
 * rather than pretending to work: a toggle that silently forgets is worse than
 * a loud mistake, and the provider is unconditional in src/app/_layout.tsx.
 */
export function useThemePref(): ThemePrefState {
  const ctx = useContext(ThemePrefContext);
  if (!ctx) throw new Error('useThemePref() used outside <ThemePrefProvider>');
  return ctx;
}

/**
 * The resolved palette — 'light' | 'dark' — for everything that just needs to
 * know which one is on (`useUi()`, the root layout, hooks/use-color-scheme).
 *
 * Falls back to the OS outside the provider instead of throwing, because this
 * one is called from shared leaf components that may be rendered in isolation
 * (the root ErrorBoundary's subtree, a future test harness). Both hooks are
 * called unconditionally so hook order is stable either way.
 */
export function useResolvedColorScheme(): ResolvedScheme {
  const ctx = useContext(ThemePrefContext);
  const system: ResolvedScheme = useSystemColorScheme() === 'dark' ? 'dark' : 'light';
  return ctx ? ctx.scheme : system;
}
