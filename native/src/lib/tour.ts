/**
 * The first-run tour: whether to show it, and the steps it shows.
 *
 * WHY IT EXISTS. Hawkeye asks a stranger to do something specific and slightly
 * unusual — stand at a polling unit and photograph a results sheet — through a
 * shell with five tabs, none of which announces itself. Osun 2026 recorded
 * twelve observers and zero reports; that was a recruitment problem, but an app
 * whose main action is a green circle with a camera in it should still say so
 * once.
 *
 * WHEN IT FIRES. The first time the app reaches Home, and never again. NOT wired
 * into the sign-up handler, deliberately: `router.replace('/(tabs)')` appears at
 * five places in sign-in.tsx (password, OTP, two resume paths, and browse-
 * without-an-account), and a tour hung off one of them would silently miss the
 * other four. One trigger on the screen everybody lands on cannot be bypassed by
 * an auth path nobody remembered to patch. It also means someone browsing
 * without an account gets it, which is right — they are the person most likely
 * to need it.
 *
 * HOW IT FAILS. Silently and open. Storage errors resolve to "already seen", so
 * a broken AsyncStorage shows the tour to nobody rather than to everybody on
 * every launch. A tour is the least important thing on the screen and must never
 * be the reason an election app misbehaves.
 *
 * Storage follows lib/review.ts: one key, written BEFORE the thing it gates, one
 * try/catch around everything, and a caller that carries no policy.
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_KEY = 'hawkeye_tour_seen';

/**
 * The same fact, held in memory.
 *
 * AsyncStorage is ASYNCHRONOUS and the dismissal is not. Nothing awaits
 * `markTourSeen()` — a press handler should not have to — so between the press
 * and the write landing there is a window in which `shouldShowTour()` still
 * answers "never seen". Anything that remounts the component in that window
 * (a tab swap, a hot reload) would reopen the tour at card one.
 *
 * Awaiting the write in the handler would not close it either; the remount can
 * happen first. A synchronous in-memory answer does, because it is set in the
 * same tick as the press.
 *
 * Same principle as lib/review.ts recording its timestamp BEFORE the request it
 * gates: the flag has to be true from the instant the decision is made, not from
 * whenever storage gets round to it.
 *
 * (This is a real window, but it is NOT what made the tour look stuck open in
 * the browser harness — that was react-native-web's Modal fade-out waiting on a
 * requestAnimationFrame that a non-compositing tab never fires. Our state was
 * already correct. Recorded so the next person does not re-diagnose it.)
 */
let seenThisRun = false;

/** The five tabs, by the `name=` each Tabs.Screen is registered under. */
export type TabRoute = 'index' | 'results' | 'report' | 'alerts' | 'more';

export type TourStep = {
  /** Feather icon name — kept as a string so this file imports no UI. */
  icon: string;
  title: string;
  body: string;
  /**
   * WHICH TAB THIS STEP IS ABOUT. The tour describes the bar the reader is
   * looking at, so while a step is open its tab is lit up down there — a
   * description of a button, next to the button. Positional order used to be
   * the only link between the two, which meant reordering the steps silently
   * pointed every one of them at the wrong tab.
   */
  route: TabRoute;
  /**
   * This step describes the raised green Report button rather than a plain tab
   * glyph, so its chip is drawn as that button instead of as a generic icon.
   * A flag, not `icon === 'camera'`: what makes Report special is that it is
   * the CTA, not which glyph it happens to use.
   */
  cta?: true;
};

/**
 * Five steps, one per tab, in tab order — so the tour reads left to right along
 * the bar the reader is looking at.
 *
 * Written to the same standard as lib/content.ts: tightened from what the app
 * and the site already say, never invented. Nothing here promises a feature or
 * an outcome, and nothing claims a relationship with INEC.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    icon: 'home',
    route: 'index',
    title: 'Home',
    body:
      'Elections open now, reports accepted so far, and a live feed.',
  },
  {
    icon: 'bar-chart-2',
    route: 'results',
    title: 'Results',
    body:
      'Pick a race for its map and running tally. Follow one to get alerts.',
  },
  {
    icon: 'camera',
    route: 'report',
    cta: true,
    title: 'Report — the green button',
    body:
      'Report a result sheet, a collation result, or an incident. This is what makes you an observer.',
  },
  {
    icon: 'bell',
    route: 'alerts',
    title: 'Alerts',
    body:
      'What has happened on the races you follow — reports accepted, units flagged, and anything Hawkeye needs to tell you.',
  },
  {
    icon: 'menu',
    route: 'more',
    title: 'More',
    body:
      'Practice runs, the ledger, the docket and the guide. Start with Practice Run.',
  },
];

/**
 * Has this device seen the tour?
 *
 * Returns FALSE on any error — the safe direction. An unreadable flag means we
 * cannot prove the tour was shown, and showing it a second time to one person is
 * a much smaller cost than a storage fault putting it in front of everyone on
 * every launch, which is what returning `true`-on-error would eventually do once
 * the write also failed.
 */
export async function shouldShowTour(): Promise<boolean> {
  if (seenThisRun) return false;
  try {
    return (await AsyncStorage.getItem(SEEN_KEY)) === null;
  } catch {
    return false;
  }
}

/**
 * Record that the tour is done — finished OR skipped, which are the same fact
 * as far as this flag is concerned. Skipping means "I do not want this", and an
 * app that re-asks tomorrow has not listened.
 */
export async function markTourSeen(): Promise<void> {
  // SYNCHRONOUS FIRST, and before the await — see `seenThisRun`. A caller that
  // does not await this (nothing should have to) is still safe from the instant
  // it returns control.
  seenThisRun = true;
  try {
    await AsyncStorage.setItem(SEEN_KEY, '1');
  } catch {
    // A tour flag is never worth an error in front of a user. The in-memory
    // flag still holds for this run, so a storage fault costs a repeat on the
    // next launch and nothing worse.
  }
}

/** Clear both flags, so More → "Take the tour" can replay it. */
export async function resetTour(): Promise<void> {
  seenThisRun = false;
  try {
    await AsyncStorage.removeItem(SEEN_KEY);
  } catch {
    // As above.
  }
}

/**
 * WHICH TAB IS LIT, while the tour is open.
 *
 * The tour is an RN <Modal>, which is a separate native window above the whole
 * React root — so the tab bar renders underneath it and nothing inside the
 * modal can draw on it. The ring therefore has to be drawn by the tab bar
 * itself, which means the two need a channel between them.
 *
 * A module-level value plus listeners, copied from lib/push.ts's unread badge —
 * the same shape, driving the same file, for the same reason: the tab bar and
 * the thing that knows the state always agree, with no state library and no
 * context provider wrapped around the app for one ring.
 */
let spotlight: TabRoute | null = null;
const spotListeners = new Set<() => void>();

/** The tab the open tour step is about, or null when no tour is showing. */
export function useTourSpotlight(): TabRoute | null {
  return useSyncExternalStore(
    (cb) => {
      spotListeners.add(cb);
      return () => spotListeners.delete(cb);
    },
    () => spotlight,
    () => spotlight,
  );
}

/** Light a tab, or pass null to put the bar back to normal. */
export function setTourSpotlight(route: TabRoute | null): void {
  if (spotlight === route) return;
  spotlight = route;
  spotListeners.forEach((fn) => fn());
}
