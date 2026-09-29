import { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/lib/auth';
import { t as i18nT } from '@/lib/i18n';

/**
 * The native half of the Android App Link (docs/DEEP-LINKS.md).
 *
 * A Telegram inline button may only carry http(s) — the app's own `hawkeye://`
 * scheme is not accepted there — so the bot links `https://hawkeye.com.ng/open?
 * to=…`. Android hands a verified /open URL to this route instead of the
 * browser; when the app is NOT installed the identical URL renders app/open.html
 * and continues on the website. One link, no "do you have the app?" branch.
 *
 * This screen never renders for long: it resolves the target and REPLACES
 * itself, so Back returns to wherever the user came from rather than to a
 * redirect stub.
 */
const TARGETS: Record<string, string> = {
  report: '/report/result',
  collation: '/report/collation',
  incident: '/report/incident',
  mapunit: '/map-unit',
  ledger: '/ledger',
  results: '/(tabs)/results',
  activity: '/profile',
  ask: '/assistant',
  // Same target as app/open/index.html (App Store In-App Events link Lite there).
  practiceday: '/practice-day',
  // The election-day readiness check (app/ready.tsx); web twin ready.html.
  ready: '/ready',
  // Native screens for signed-in web pages (lib/web-routes.ts): a bot button
  // must never hand the app to a signed-out browser tab. Same names on the web
  // twin, app/open/index.html.
  groups: '/my-groups',
  captain: '/captain',
};

export default function Open() {
  // Everything except `to` is passed straight through, so the bot's existing
  // ?pu=&contest=&votes= handoff survives the hop into the app.
  const { to, ...rest } = useLocalSearchParams<{ to?: string }>();
  // Resolved by now: the root layout renders no Stack while auth is 'loading'.
  const auth = useAuth();

  useEffect(() => {
    /*
     * AN INVITE LINK — /open?to=invite&ref=CODE&unit=PU (app/invite-unit.js,
     * lib/invite-unit.ts, lib/referral.ts). +native-intent.tsx has already
     * parked the code and unit (lib/pending-invite.ts; sign-up waits for that
     * write), so this only chooses the screen:
     *   signed out → the create-account form, code filled in. Welcome goes
     *     UNDER it, so its close button returns to the door, as when "Become an
     *     observer" opens it — on a cold start there is nothing else to return to.
     *   signed in  → home. An invitation only attaches to a NEW account.
     * The root layout lets a signed-out reader stay on /open for this reason.
     */
    if (String(to || '') === 'invite') {
      if (auth.status === 'signedIn') {
        router.replace('/(tabs)');
      } else if (router.canGoBack()) {
        router.replace('/sign-in?intent=signup');
      } else {
        router.replace('/welcome');
        router.push('/sign-in?intent=signup');
      }
      return;
    }
    const path = TARGETS[String(to || '')] ?? '/(tabs)';
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v != null) params[k] = Array.isArray(v) ? v[0] : String(v);
    }
    // replace, not push: a redirect must not sit in the back stack.
    router.replace(
      Object.keys(params).length ? ({ pathname: path, params } as never) : (path as never),
    );
    // Intentionally once-only — re-running on every param identity change would
    // fight the navigation it just performed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View className="flex-1 items-center justify-center bg-surface">
      <ActivityIndicator />
      <Text className="pt-3 text-sm text-muted">{i18nT('n.app.open.opening')}</Text>
    </View>
  );
}
