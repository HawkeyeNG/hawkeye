/**
 * RUN A PUBLISHED OTA WITHOUT WAITING FOR TWO COLD STARTS (2026-10-03).
 *
 * app.json has checkAutomatically ON_LOAD with fallbackToCacheTimeout 0: a
 * launch DOWNLOADS a new update but keeps running the one it started with, and
 * the new code runs only from the NEXT cold launch. iOS keeps the app alive in
 * the background for days, so a phone could run old JavaScript long after an
 * update — the owner saw the paid "get a code on WhatsApp" link on 3 Oct, a day
 * after the OTA that hid it.
 *
 * Now, when the app comes back to the foreground after at least AWAY_MS away,
 * it asks the update server; if something newer than the running code exists
 * (including one already downloaded at launch), it is fetched and the app
 * reloads onto it at once. Only after a real absence: a short trip out is
 * someone mid-task — sending the WhatsApp sign-in message, reading a Telegram
 * code, a permission sheet — and a reload would throw their screen away.
 * Never in development, never twice at once; any failure leaves the running
 * code as it was.
 */
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';

export const AWAY_MS = 15 * 60_000;

type UpdatesApi = {
  isEnabled: boolean;
  checkForUpdateAsync: () => Promise<{ isAvailable: boolean }>;
  fetchUpdateAsync: () => Promise<unknown>;
  reloadAsync: () => Promise<void>;
};

/**
 * The state machine, apart from React so a test can drive it. Returns the
 * AppState listener; `now` and `api` are injectable.
 */
export function freshUpdatesListener(api: UpdatesApi = Updates as unknown as UpdatesApi, now: () => number = Date.now) {
  let awayAt: number | null = null;
  let busy = false;
  return (s: AppStateStatus): Promise<boolean> | void => {
    if (s === 'background') {
      awayAt = now();
      return;
    }
    if (s !== 'active' || awayAt === null || busy) return;
    const away = now() - awayAt;
    awayAt = null;
    if (away < AWAY_MS || !api.isEnabled) return;
    busy = true;
    return (async () => {
      try {
        const c = await api.checkForUpdateAsync();
        if (!c.isAvailable) return false;
        await api.fetchUpdateAsync();
        await api.reloadAsync();
        return true;
      } catch {
        return false; // stay on the running code
      } finally {
        busy = false;
      }
    })();
  };
}

/** Mounted once, in the root layout. */
export function useFreshUpdates(): void {
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;
    const listener = freshUpdatesListener();
    const sub = AppState.addEventListener('change', (s) => { void listener(s); });
    return () => sub.remove();
  }, []);
}
