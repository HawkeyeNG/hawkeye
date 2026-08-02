import { useResolvedColorScheme } from '@/lib/theme-pref';

/**
 * Colours for props that cannot take a className — icon tints, bottom-sheet
 * background/handle styles, SVG fills, placeholderTextColor.
 *
 * The class-level palette lives in global.css as CSS variables and is surfaced
 * through tailwind.config.js; this mirrors, in JS, the values that must follow
 * the theme somewhere a className cannot reach. Keep the two in step — every
 * entry is the `--x` variable of the same name, in hex — with one inherited
 * exception: light `faint` is #9db5a7 while --faint is #8d9c93. Every icon in
 * the app already passes the former, so it is kept rather than silently
 * re-tinted; align the two in one deliberate pass if it ever grates.
 *
 * WHICH THEME IS ON is not read from the OS here. It comes from
 * `useResolvedColorScheme()` (src/lib/theme-pref.tsx), the same source that
 * picks the `theme-light` / `theme-dark` class driving those CSS variables, so
 * a manual Light/Dark preference moves the classes and these hexes together. It
 * used to be react-native's `useColorScheme()`, which no override can reach —
 * leaving every icon in the app on the OS theme while the surfaces behind them
 * followed the user. Do not put it back.
 */

/** Every semantic colour, per theme. Exported so a component that needs the
 *  whole map (a memo, a StyleSheet built outside a hook) can read it. */
export const PALETTE = {
  light: {
    surface: '#e8f2ec',
    card: '#ffffff',
    ink: '#10221a',
    muted: '#526058',
    faint: '#9db5a7',
    line: '#e2ece6',
    /** Tinted surfaces + the ink that sits on them. See --good/--bad/--warn. */
    good: '#dff2e8',
    goodInk: '#0b6b3a',
    bad: '#fee9e8',
    badInk: '#b91c1c',
    warn: '#fef3dc',
    warnInk: '#b45309',
    /** Hazard yellow — safety of person only, never an informational notice.
     *  See --caution in global.css. */
    caution: '#f5d90a',
    cautionInk: '#7a3e00',
    /** Choropleth land with nothing to say about it, and its border. */
    noData: '#e9eeea',
    mapLine: '#b7bcb7',
  },
  dark: {
    surface: '#08140e',
    card: '#12241b',
    ink: '#e8f2ec',
    muted: '#9eb0a5',
    faint: '#6e8076',
    line: '#20382b',
    good: '#103824',
    goodInk: '#6edba0',
    bad: '#42181a',
    badInk: '#fca5a5',
    warn: '#402c0c',
    warnInk: '#fcd34d',
    caution: '#6b5200',
    cautionInk: '#fae014',
    noData: '#26362d',
    mapLine: '#4a5b51',
  },
} as const;

export type Tone = 'good' | 'bad' | 'warn';

/**
 * The tint keys — `Tone` plus `caution`, which is NOT a tone.
 *
 * Kept as a separate type on purpose. Components declare exhaustive maps over
 * `Tone` (components/content-kit.tsx's TINT is a `Record<Tone, …>`), so adding
 * 'caution' to that union would turn every one of them into a type error, and
 * "fixing" them by filling in a caution branch would offer hazard yellow as a
 * routine notice style — exactly what the pair is not for. `useUi().tint`
 * therefore covers `TintKey` while `Tone` keeps meaning the three tones any
 * informational surface may pick from.
 */
export type TintKey = Tone | 'caution';

export function useUi() {
  const dark = useResolvedColorScheme() === 'dark';
  const p = dark ? PALETTE.dark : PALETTE.light;
  return {
    dark,
    /** Primary icon tint — near-black on light, near-white on dark. */
    ink: p.ink,
    /** Chevrons, dividers, anything deliberately quiet. */
    faint: p.faint,
    /** Secondary text, when a prop needs it rather than a class. */
    muted: p.muted,
    /** Raised card — bottom sheets, modals styled through a style object. */
    card: p.card,
    /** Screen background. */
    surface: p.surface,
    /** Hairlines. */
    line: p.line,
    /** Choropleth fill for a region with no data, and the border between them. */
    noData: p.noData,
    mapLine: p.mapLine,
    /**
     * Tinted surfaces, keyed by tint, for props that take a colour value.
     * `bg` matches the Tailwind class of the same name (bg-good/bg-bad/bg-warn/
     * bg-caution) and `ink` matches text-good-ink/text-bad-ink/text-warn-ink/
     * text-caution-ink — so an icon on a tinted card takes its colour from here
     * rather than a hardcoded hex that cannot follow the theme.
     *
     * `caution` is the safety-of-person pair and is not interchangeable with
     * `warn`; see --caution in global.css.
     */
    tint: {
      good: { bg: p.good, ink: p.goodInk },
      bad: { bg: p.bad, ink: p.badInk },
      warn: { bg: p.warn, ink: p.warnInk },
      caution: { bg: p.caution, ink: p.cautionInk },
    } satisfies Record<TintKey, { bg: string; ink: string }>,
  };
}
