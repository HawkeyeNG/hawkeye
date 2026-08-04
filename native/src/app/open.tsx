import { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

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
};

export default function Open() {
  // Everything except `to` is passed straight through, so the bot's existing
  // ?pu=&contest=&votes= handoff survives the hop into the app.
  const { to, ...rest } = useLocalSearchParams<{ to?: string }>();

  useEffect(() => {
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
      <Text className="pt-3 text-sm text-muted">Opening…</Text>
    </View>
  );
}
