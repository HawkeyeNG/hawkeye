/**
 * Ask for a Play Store rating, at a moment the user is likely to feel good.
 *
 * WHY THIS EXISTS. The Play listing has zero ratings. Rating count and recency
 * are inputs to Play's search ranking AND to whether a stranger installs, so
 * zero is expensive twice over. Twenty ratings is a materially different
 * listing from none.
 *
 * WHEN TO ASK. Only after the user finishes something successfully — currently
 * a completed practice run, which is the one flow that works between elections.
 * Never after an error, never on launch, and never during a real report: a
 * person standing at a polling unit on election day has exactly one job and it
 * is not rating an app.
 *
 * PINNED TO 57.0.1, EXACTLY — do not widen this to ~57.0.1 or bump it on its
 * own. expo-store-review 57.0.2's iOS module calls `SceneGeometry`, a helper
 * added to ExpoModulesCore after the 57.0.7 this project has, so it fails the
 * iOS build with "cannot find 'SceneGeometry' in scope" — a Swift error that
 * says nothing about which package caused it. It only bites on iOS; Android
 * builds fine either way, which is why it went unnoticed. The real fix is to
 * bring the whole SDK up to its current patch level (`npx expo install --fix`
 * moves 18 packages, react-native included) — worth doing deliberately, with
 * an Android regression pass, not as a side effect of a store listing change.
 *
 * HOW IT BEHAVES. `expo-store-review` shows Google's own in-app review sheet,
 * which never leaves the app. Google decides whether to actually display it and
 * silently ignores the request when quota is spent — there is no callback and
 * no way to know, by design, so that apps cannot detect and pester. Everything
 * here therefore fails soft: if the module is missing, the platform declines,
 * or anything throws, the user simply sees nothing.
 *
 * WE STILL RATE-LIMIT OURSELVES. Google's quota is undocumented and shared
 * across the app, so asking on every single practice run would burn it on the
 * same handful of people. Once per 90 days per device, and never before the
 * user has finished at least two runs — someone who has done it once has not
 * yet decided whether they like it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const LAST_ASKED_KEY = 'hawkeye_review_last_asked';
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Minimum completed practice runs before the first ask. */
export const MIN_RUNS_BEFORE_ASK = 2;

/**
 * Request a review if it is a reasonable moment to.
 *
 * @param completedRuns how many practice runs this person has finished
 * @returns whether a request was made — NOT whether a prompt was shown, which
 *          Google does not tell us
 */
export async function maybeAskForReview(completedRuns: number): Promise<boolean> {
  try {
    if (completedRuns < MIN_RUNS_BEFORE_ASK) return false;

    const last = await AsyncStorage.getItem(LAST_ASKED_KEY);
    if (last && Date.now() - Number(last) < NINETY_DAYS_MS) return false;

    // Imported lazily so a build without the module — or a web build, where it
    // does not apply — cannot fail at startup over a nice-to-have.
    const StoreReview = await import('expo-store-review');

    if (!(await StoreReview.hasAction())) return false;

    // Recorded BEFORE the request, not after. If the call throws halfway we
    // still back off; the alternative is retrying on every run against a
    // platform that is already refusing us.
    await AsyncStorage.setItem(LAST_ASKED_KEY, String(Date.now()));
    await StoreReview.requestReview();
    return true;
  } catch {
    // A rating prompt is never worth an error in front of a user.
    return false;
  }
}
