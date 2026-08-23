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

export type TourStep = {
  /** Feather icon name — kept as a string so this file imports no UI. */
  icon: string;
  title: string;
  body: string;
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
    title: 'Home',
    body:
      'The elections being reported now or coming next, how many reports have been accepted, and a live feed of what other observers are sending in.',
  },
  {
    icon: 'bar-chart-2',
    title: 'Results',
    body:
      'The public leaderboard. Pick a race to see the map, the running tally and which polling units have reported. You can follow a single seat and get alerts on it.',
  },
  {
    icon: 'camera',
    title: 'Report — the green button',
    body:
      'The middle button is the one that matters. It opens three choices: report a result sheet, report a collation result, or report an incident. This is what makes you an observer.',
  },
  {
    icon: 'bell',
    title: 'Alerts',
    body:
      'What has happened on the races you follow — reports accepted, units flagged, and anything Hawkeye needs to tell you.',
  },
  {
    icon: 'menu',
    title: 'More',
    body:
      'Everything else: a practice run you can do today, the ledger you can verify yourself, the public docket, and the observer guide. Start with Practice Run.',
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
