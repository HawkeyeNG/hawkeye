/**
 * Release decoded bitmaps when the app is not on screen.
 *
 * WHY THIS EXISTS. Google Play's new quality thresholds (announced August 2026,
 * enforced from February 2027) measure BITMAP MEMORY alongside dynamic memory,
 * and state the rule plainly: bitmaps should not persist in memory while the app
 * is backgrounded or cached. Missing a threshold costs "reduced app visibility
 * and publishing capabilities" — a penalty aimed squarely at discovery, which is
 * already this app's hardest problem.
 *
 * Hawkeye is unusually exposed. It is a camera app whose subject is a full-page
 * result sheet, and the report flow holds two of them at once (the EC8A and the
 * venue photo) plus whatever the review step is showing. A decoded bitmap is
 * several times the JPEG it came from, and it stays decoded for as long as
 * something holds it — including while the phone is in a pocket between polling
 * units.
 *
 * WHAT IT DOES NOT DO. It does not touch the disk cache, so returning to the app
 * re-decodes from local storage rather than re-downloading. The cost is a few
 * milliseconds on resume; the alternative is being throttled in the store.
 *
 * ONLY 'background', NOT 'inactive'. On iOS a transient interruption — the app
 * switcher, Notification Centre, a permissions dialog — fires 'inactive' without
 * the app ever leaving the screen. Purging there would re-decode every image the
 * user is still looking at, several times a session, to no benefit.
 *
 * FAILS SOFT, ALWAYS. A cache purge is never worth an error in front of an
 * observer, least of all on election day. Every failure path here ends in
 * nothing happening.
 */
import { Image } from 'expo-image';
import { AppState } from 'react-native';

let registered = false;

/**
 * Register the listener. Idempotent: importing this module more than once, or a
 * fast-refresh re-evaluation in development, must not stack listeners that each
 * purge the cache on every background.
 */
export function initMemoryRelief(): void {
  if (registered) return;
  registered = true;
  try {
    AppState.addEventListener('change', (state) => {
      if (state !== 'background') return;
      try {
        void Image.clearMemoryCache().catch(() => {});
      } catch {
        /* older expo-image, or a platform without the native module */
      }
    });
  } catch {
    /* no AppState (tests, some web contexts) — there is nothing to release */
  }
}

initMemoryRelief();
