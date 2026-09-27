import { useEffect } from 'react';
import { AppState } from 'react-native';

/**
 * Run `fn` now, then every `ms` — but only while the app is in the foreground.
 *
 * WHY. Screens poll every 30 s and tabs stay mounted, so the home tab's six
 * requests (and the other boards) kept going with the phone in a pocket: the
 * observer's mobile data and the origin's capacity, spent on a screen nobody
 * was looking at (docs/private/ELECTION-NIGHT-HOSTING.md §5 item 4). Going to
 * the background stops the timer; coming back refreshes at once and restarts
 * it. iOS's brief 'inactive' (control centre, the app switcher) changes nothing.
 *
 * `fn` must be STABLE — a useCallback. The effect re-runs when it changes,
 * which is how a board's poll follows its own inputs (the map's contest, the
 * results tab's race): the same contract as the `setInterval(load)` effects
 * this replaces. An inline arrow would restart the timer on every render.
 */
export function useForegroundInterval(fn: () => unknown, ms: number): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    // A poll's failure is the poll's business; never an unhandled rejection here.
    const run = () => {
      void Promise.resolve()
        .then(fn)
        .catch(() => undefined);
    };
    const start = () => {
      if (timer == null) timer = setInterval(run, ms);
    };
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = null;
    };
    run();
    if (AppState.currentState !== 'background') start();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') stop();
      else if (s === 'active' && timer == null) {
        run();
        start();
      }
    });
    return () => {
      stop();
      sub.remove();
    };
  }, [fn, ms]);
}
