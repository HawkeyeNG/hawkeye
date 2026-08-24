/**
 * Native push, and the notification centre's shared state.
 *
 * Two things the Alerts screen cannot own by itself. The unread count, because
 * the tab badge has to be right before that lazily-mounted screen has ever
 * rendered. And where a notification points, because a tap can arrive while the
 * app is backgrounded — or not running at all — long before any screen is up.
 * `usePushNotifications()` in the root layout is the single wire-up for both.
 */
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import * as SecureStore from '@/lib/secure-store';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { BRAND } from '@/lib/api';
import { authedGet, useAuth } from '@/lib/auth';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const CHANNEL = 'default';

/**
 * lib/auth.ts ships authedGet only, and these are the app's first authenticated
 * POSTs outside a screen. The token is read from SecureStore under the key
 * lib/auth.ts writes, the same way app/profile.tsx does it.
 */
async function authedPost<T>(path: string, body: object): Promise<T> {
  const token = await SecureStore.getItemAsync('hawkeye.auth.token');
  if (!token) throw new Error('not signed in');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ---- unread count -----------------------------------------------------------
// Same shape as lib/auth.ts's store: a module-level value plus listeners, read
// through useSyncExternalStore, so the tab bar and the Alerts list always agree
// without a state library or a context provider between them.

let unread = 0;
const listeners = new Set<() => void>();

/** Unread notifications, for the Alerts tab badge and the screen's own footer. */
export function useUnread(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => unread,
  );
}

/** The server's count is authoritative — callers pass what /api/notifications said. */
export function setUnread(next: number) {
  const n = Math.max(0, next);
  if (n === unread) return;
  unread = n;
  listeners.forEach((l) => l());
}

/**
 * Re-read the count. There is no count-only endpoint, so this is the feed
 * request; the Alerts screen sets the count from its own load instead of
 * calling this, and pays for the round trip once.
 */
export async function refreshUnread(): Promise<void> {
  try {
    const r = await authedGet<{ unread: number }>('/api/notifications');
    setUnread(r.unread);
  } catch {
    // A stale badge is not worth a visible failure. The Alerts screen reports
    // its own load errors when someone actually opens it.
  }
}

/** Mark one notification (by id) or the whole feed read. Throws so the caller can say so. */
export async function markRead(target: number | 'all'): Promise<void> {
  const r = await authedPost<{ ok: boolean; unread: number }>(
    '/api/notifications/read',
    target === 'all' ? { all: true } : { id: target },
  );
  setUnread(r.unread);
}

// ---- where a notification points --------------------------------------------

/**
 * The backend writes notification urls as links into the website
 * (backend/src/services/notifications.js and its callers), because the same row
 * feeds the web app's bell. Each one that has a native twin is listed here;
 * anything else — the review console, a page not rebuilt yet — is still
 * reachable, just in an in-app browser tab.
 */
const ROUTES: Record<string, string> = {
  '': '/',
  'index.html': '/',
  'results.html': '/results',
  'notifications.html': '/alerts',
  'dashboard.html': '/reports-log',
  'incidents.html': '/incidents',
  'docket.html': '/docket',
  'ledger.html': '/ledger',
  'integrity.html': '/integrity',
  'osun.html': '/osun',
  'candidates.html': '/candidates',
  'political.html': '/political',
  'profile.html': '/profile',
  'map-unit.html': '/map-unit',
  'practice.html': '/practice',
  'observe.html': '/report/result',
  'collation.html': '/report/collation',
  'how.html': '/page?slug=how',
  'guide.html': '/page?slug=guide',
  'faq.html': '/page?slug=faq',
  'about.html': '/page?slug=about',
  'privacy.html': '/page?slug=privacy',
  'terms.html': '/terms',
};

/** Every route the table can produce, so a url already written as one is honoured. */
const NATIVE = new Set([...Object.values(ROUTES).map((r) => r.split('?')[0]), '/case']);

function nativeRoute(url: string): string | null {
  // Absolute is what the backend sends today; a bare path is just as valid a
  // thing to be handed, so both are parsed. A link to anywhere but our own
  // origin is never rewritten to a native screen.
  const origin = /^https?:\/\/[^/]+/i.exec(url)?.[0];
  if (origin && origin.toLowerCase() !== BASE) return null;
  const [file, query = ''] = url.slice(origin?.length ?? 0).replace(/^\//, '').split('?');
  if (file === 'case.html') {
    // The case id is the whole point of the link; without one the docket index
    // is the honest destination rather than a case screen with nothing to show.
    const id = /(?:^|&)id=(\d+)/.exec(query)?.[1];
    return id ? `/case?id=${id}` : '/docket';
  }
  if (Object.hasOwn(ROUTES, file)) return ROUTES[file];
  const path = `/${file}`;
  return NATIVE.has(path) ? (query ? `${path}?${query}` : path) : null;
}

/** Open what a notification is about — native screen if there is one, browser otherwise. */
export function openNotificationTarget(url: string | null | undefined) {
  if (!url) return;
  const route = nativeRoute(url);
  if (route) {
    router.push(route as never);
    return;
  }
  WebBrowser.openBrowserAsync(/^https?:/i.test(url) ? url : `${BASE}/${url.replace(/^\//, '')}`);
}

// ---- registration and delivery ----------------------------------------------

// Without this a push that lands while the app is open is swallowed silently.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  // The backend's FCM messages name no channel (backend/src/services/push.js),
  // so they fall to the app default — which has to exist before the first one
  // arrives or API 26+ drops it on the floor.
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Alerts',
    description: 'Reports at your unit, results in dispute, and replies to what you filed.',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: BRAND.gold,
  });
}

/**
 * Hand this device's push token to the backend. Call after sign-in — the token
 * is stored against an observer, so there is nothing to register before one.
 */
export async function registerForPush(): Promise<void> {
  try {
    // Emulators have no FCM/APNs registration to hand out; asking throws.
    if (!Device.isDevice) return;
    await ensureAndroidChannel();
    const current = await Notifications.getPermissionsAsync();
    const status = current.granted
      ? current.status
      : (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;
    // getDevicePushTokenAsync, not getExpoPushTokenAsync: the backend signs its
    // own FCM v1 sends against the raw device token, so an Expo push token would
    // be registered and then never delivered to.
    const token = await Notifications.getDevicePushTokenAsync();
    const platform = token.type === 'ios' ? 'ios' : 'android';

    /**
     * ON iOS, ASK FIREBASE — expo-notifications hands back an APNs token.
     *
     * `getDevicePushTokenAsync()` returns the raw APNs device token on iOS, and
     * the server sends through FCM v1, which cannot deliver to one. Every iOS
     * registration therefore stored a token nothing could ever use;
     * services/push.js:113 recognises the 64-hex shape and declines to send
     * rather than fail, which is why this was silent rather than noisy.
     *
     * @react-native-firebase/messaging returns the FCM token for the same
     * device. Getting it needs the APNs token to have been registered with
     * Firebase first — which the call above has just caused — so the ORDER here
     * matters and is not incidental.
     *
     * Android is untouched: expo-notifications already returns an FCM token
     * there, and routing it through a second SDK would be a new way for a
     * working path to break.
     *
     * FAILS BACK, not open. If messaging throws or returns nothing, the APNs
     * token is registered as before: the server still declines to send to it, so
     * the outcome is exactly today's behaviour rather than a lost registration.
     */
    let deviceToken = String(token.data);
    if (platform === 'ios') {
      try {
        // MODULAR API, no default export. @react-native-firebase v22 dropped the
        // namespaced `messaging().getToken()` form; v26 (what is installed) only
        // ships the tree-shakeable functions, so the old shape does not
        // typecheck and would not run.
        const { getMessaging, getToken } = await import('@react-native-firebase/messaging');
        const fcm = await getToken(getMessaging());
        if (fcm) deviceToken = fcm;
      } catch {
        // No Firebase config in this build, or the APNs registration has not
        // landed yet. Keep the APNs token; it is inert, not harmful.
      }
    }

    await authedPost('/api/push/register', { token: deviceToken, platform });
  } catch {
    // No Firebase config in the build, permission denied, backend down — none
    // of it is worth interrupting someone for. The in-app feed still works.
  }
}

// useLastNotificationResponse replays the tap that launched the app to every
// mount of the hook, and the response outlives the launch it belongs to. Both
// have to be answered or a normal app open re-navigates somewhere the observer
// went yesterday: this remembers what was acted on, and the response is cleared
// once it has been.
let handled: string | null = null;


/**
 * useLastNotificationResponse, or null on web.
 *
 * expo-notifications has no web implementation of getLastNotificationResponse
 * and THROWS rather than returning null. That throw is in the ROOT LAYOUT, which
 * the app cannot survive: its own error boundary catches it and every route
 * renders "This screen hit a problem" instead of the app.
 *
 * It matters beyond curiosity, because `expo export --platform web` is how the
 * Play listing's screenshots are taken (scripts/play_screenshots_native.mjs) —
 * a root-layout throw makes every frame an error page. There is no push on web
 * to lose: this app ships on Android, and iOS next.
 *
 * Bound at MODULE LOAD, not per render. Platform.OS cannot change while the app
 * is running, so this is one implementation for the process — which keeps the
 * call site unconditional and the hook order identical on every render.
 */
const useLastNotificationResponse: () => Notifications.NotificationResponse | null | undefined =
  Platform.OS === 'web' ? () => null : Notifications.useLastNotificationResponse;

/**
 * The root layout's one call: registers for push once signed in, keeps the
 * unread badge honest, and routes a notification tap to what it is about.
 */
export function usePushNotifications(): void {
  const auth = useAuth();
  const response = useLastNotificationResponse();

  useEffect(() => {
    if (auth.status !== 'signedIn') {
      setUnread(0);
      return;
    }
    registerForPush();
    refreshUnread();
  }, [auth.status]);

  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (id === handled) return;
    handled = id;
    Notifications.clearLastNotificationResponse();
    const url = response.notification.request.content.data?.url;
    openNotificationTarget(typeof url === 'string' ? url : null);
    // The push carries a url and nothing else (backend/src/services/push.js), so
    // there is no row id to mark read here — but the feed has moved since the
    // badge was last right, so re-read it.
    refreshUnread();
  }, [response]);

  useEffect(() => {
    // Notifications arrive while the app is away. The badge should be right the
    // moment it comes back, not only once Alerts is opened.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refreshUnread();
    });
    const received = Notifications.addNotificationReceivedListener(() => refreshUnread());
    return () => {
      sub.remove();
      received.remove();
    };
  }, []);
}
