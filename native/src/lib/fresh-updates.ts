/**
 * RUN A PUBLISHED OTA WITHOUT WAITING FOR TWO COLD STARTS (2026-10-03) —
 * BUT NEVER IN THE MIDDLE OF SOMETHING.
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
 * (including one already downloaded at launch), it is fetched — and applied
 * ONLY AT A SAFE MOMENT (owner, 2026-10-03): the app is on a tab root (Home,
 * Alerts, Results, More — not Report, which holds a draft), no sheet or modal
 * is open (HoldUpdates sits inside every Modal), and the outbox has nothing
 * queued or sending. Otherwise the reload waits for the next safe moment (a
 * return to the app, or arriving on such a tab) or simply the next cold start.
 * So the WhatsApp sign-in waiting screen, a report, an incident, a practice
 * run or any open form is never thrown away. Never in development; any failure
 * leaves the running code as it was.
 */
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';
import { outboxBusy } from '@/lib/outbox';

export const AWAY_MS = 15 * 60_000;

type UpdatesApi = {
  isEnabled: boolean;
  checkForUpdateAsync: () => Promise<{ isAvailable: boolean }>;
  fetchUpdateAsync: () => Promise<unknown>;
  reloadAsync: () => Promise<void>;
};

/* -------------------------------------------------- what "safe" means */
let route: string[] = [];
/** The root layout reports the route (expo-router segments) on every change. */
export function noteRoute(segments: readonly string[]): void {
  route = [...segments];
  void active?.tryApply();
}
const holds = new Set<symbol>();
/** Something on screen must not be torn down (an open sheet or modal). Returns the release. */
export function holdUpdates(): () => void {
  const k = Symbol('hold');
  holds.add(k);
  return () => {
    holds.delete(k);
    void active?.tryApply();
  };
}
/** Rendered INSIDE a Modal: React Native mounts Modal content only while it is visible. */
export function HoldUpdates(): null {
  useEffect(() => holdUpdates(), []);
  return null;
}
/** Tab roots with nothing mid-flow. Report is left out: it holds a draft. */
const SAFE_TABS = new Set(['index', 'alerts', 'results', 'more']);
export function onSafeTabRoot(seg: readonly string[]): boolean {
  if (seg[0] !== '(tabs)') return false;
  return seg.length === 1 || (seg.length === 2 && SAFE_TABS.has(seg[1]));
}
export function safeToReload(): boolean {
  return onSafeTabRoot(route) && holds.size === 0 && !outboxBusy();
}

/* -------------------------------------------------------- the machine */
type Listener = { onState: (s: AppStateStatus) => Promise<boolean> | void; tryApply: () => Promise<boolean> };
let active: Listener | null = null;

/** Apart from React so a test can drive it; `api`, `now` and `isSafe` are injectable. */
export function freshUpdatesListener(
  api: UpdatesApi = Updates as unknown as UpdatesApi,
  now: () => number = Date.now,
  isSafe: () => boolean = safeToReload,
): Listener {
  let awayAt: number | null = null;
  let busy = false;
  let ready = false; // a newer update is fetched and waiting for a safe moment
  const tryApply = async (): Promise<boolean> => {
    if (!ready || !isSafe()) return false;
    ready = false;
    try {
      await api.reloadAsync();
      return true;
    } catch {
      return false;
    }
  };
  const onState = (s: AppStateStatus): Promise<boolean> | void => {
    if (s === 'background') {
      awayAt = now();
      return;
    }
    if (s !== 'active' || awayAt === null || busy) return;
    const away = now() - awayAt;
    awayAt = null;
    if (ready) return tryApply(); // already fetched: any return is a chance, if it is safe
    if (away < AWAY_MS || !api.isEnabled) return;
    busy = true;
    return (async () => {
      try {
        const c = await api.checkForUpdateAsync();
        if (!c.isAvailable) return false;
        await api.fetchUpdateAsync();
        ready = true;
        return await tryApply();
      } catch {
        return false; // stay on the running code
      } finally {
        busy = false;
      }
    })();
  };
  active = { onState, tryApply };
  return active;
}

/** Mounted once, in the root layout. */
export function useFreshUpdates(): void {
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;
    const l = freshUpdatesListener();
    const sub = AppState.addEventListener('change', (s) => { void l.onState(s); });
    return () => sub.remove();
  }, []);
}
