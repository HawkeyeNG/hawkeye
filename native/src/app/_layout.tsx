import 'react-native-gesture-handler';
import '../global.css';
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AskFab } from '@/components/ask-fab';
import { bootstrapAuth, useAuth } from '@/lib/auth';
import { usePushNotifications } from '@/lib/push';
import { ThemePrefProvider, themeClass, useThemePref } from '@/lib/theme-pref';

SplashScreen.preventAutoHideAsync();

/**
 * expo-router renders this instead of unmounting the app when a screen throws.
 *
 * Without it one bad render took the whole app down and it did not come back —
 * unacceptable for someone standing at a polling unit with a sheet in hand. The
 * error text is shown rather than swallowed: it is the only diagnostic anyone
 * has out in the field.
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#e8f2ec' }}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={{ padding: 24, flexGrow: 1, justifyContent: 'center' }}>
          <Text style={{ fontSize: 20, fontWeight: '700', color: '#10221a' }}>
            This screen hit a problem
          </Text>
          <Text style={{ paddingTop: 8, fontSize: 14, color: '#4b5563', lineHeight: 20 }}>
            Nothing you have already sent is affected, and anything saved offline is still
            queued. Try again, or go back and take another route.
          </Text>
          <View
            style={{ marginTop: 16, borderRadius: 12, backgroundColor: '#fff', padding: 12 }}
          >
            <Text style={{ fontFamily: 'monospace', fontSize: 11, color: '#6b7280' }}>
              {error?.message ?? String(error)}
            </Text>
          </View>
          <Pressable
            onPress={() => retry()}
            style={{
              marginTop: 20,
              alignItems: 'center',
              borderRadius: 16,
              backgroundColor: '#004225',
              paddingVertical: 14,
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#f5b301' }}>Try again</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/**
 * The provider has to sit ABOVE everything that reads the theme, and a component
 * cannot consume a context it renders itself — so the root is split in two:
 * this shell owns the preference, RootShell below consumes it.
 */
/**
 * DO NOT ADD A SafeAreaProvider HERE.
 *
 * expo-router already renders one above this component
 * (expo-router/build/ExpoRoot.js), and a second, nested provider measures its
 * OWN frame rather than the window. Inside a screen presented as a
 * fullScreenModal that frame excludes the status bar, so the nested provider
 * reports a top inset of ZERO and every header on those screens — How Hawkeye
 * Works, the FAQ, Terms, integrity — rides up under the clock and stays there.
 *
 * It was added to give the first frame correct insets via initialMetrics, which
 * is a real problem but not one to solve from here: the flash is handled in
 * lib/safe-area.ts, which falls back to initialWindowMetrics only while the
 * measured value is still zero.
 */
export default function RootLayout() {
  return (
    <ThemePrefProvider>
      <RootShell />
    </ThemePrefProvider>
  );
}

function RootShell() {
  /**
   * One reading of the theme for the whole app. `scheme` already has the user's
   * Light / Dark / System choice resolved (src/lib/theme-pref.tsx), and it feeds
   * all three of the systems that decide what anything looks like:
   *
   *  1. the CSS custom properties every `bg-*` / `text-*` class resolves
   *     against — via the `themeClass()` wrapper View below;
   *  2. react-navigation's ThemeProvider, which colours the bits of chrome we
   *     never draw ourselves (screen transitions, the card behind a modal);
   *  3. the status bar.
   *
   * `useUi()` — every icon colour in the app — is the fourth, and reads the same
   * source directly. Drive fewer than all four and the app renders half-light.
   */
  const { scheme, loaded } = useThemePref();
  const dark = scheme === 'dark';
  // Registers the device once signed in, routes a notification tap to the screen
  // it is about, and keeps the unread badge honest. One place, so nothing
  // double-registers.
  usePushNotifications();
  useEffect(() => {
    bootstrapAuth();
  }, []);

  // Ask for camera + location ONCE, up front, the way the Capacitor shell does.
  // Android grants at runtime, so "on install" means the first launch: an observer
  // standing at a unit with a sheet in hand should not meet a permission dialog
  // mid-capture. Failures are ignored — every call site still requests on demand.
  useEffect(() => {
    (async () => {
      try {
        const Camera = await import('expo-camera');
        await Camera.Camera.requestCameraPermissionsAsync();
      } catch {
        /* asked again at capture time */
      }
      try {
        const Location = await import('expo-location');
        await Location.requestForegroundPermissionsAsync();
      } catch {
        /* asked again at fix time */
      }
      // Once permission is settled, keep a fix warm for as long as the app is
      // in use, so the shutter and the near-me lookup never pay a cold GPS
      // start. Foreground-only and torn down on background — see the keeper's
      // own note in lib/location.ts.
      try {
        const { startLocationKeeper } = await import('@/lib/location');
        await startLocationKeeper();
      } catch {
        /* best-effort warm-up; every fix call site keeps its own fallback */
      }
    })();
    return () => {
      import('@/lib/location').then((m) => m.stopLocationKeeper()).catch(() => {});
    };
  }, []);

  // Signed-out access tier for the APP: a signed-out user gets ONLY the auth
  // funnel (welcome / sign-in) only — practice is signed-in on the app (people who
  // downloaded it came to observe; the WEB keeps practice open for ad/social traffic).
  // Any other route — the tabs, a
  // report flow, a trust page — bounces to welcome. Signed-in users are
  // unrestricted; nothing runs until auth has resolved past 'loading'. This is
  // the native counterpart of the web's authgate.js (which keeps more public,
  // per that platform's tier). Device-verify: no flash, no loop, correct bounce.
  const auth = useAuth();
  const segments = useSegments();
  useEffect(() => {
    if (auth.status !== 'signedOut') return;
    const top = segments[0];
    const allowed = top === 'welcome' || top === 'sign-in';
    if (allowed) return;

    /**
     * DISMISS ANY OPEN MODAL BEFORE REPLACING THE STACK UNDER IT.
     *
     * This effect lives in the ROOT layout, so it fires whatever is on screen —
     * and 18 of the 20 routes here are presented as fullScreenModal. When a
     * session expires while one is open, a bare router.replace('/welcome')
     * swaps the stack UNDERNEATH it: the modal's host view is orphaned but
     * still mounted and still on top, so every touch lands on a view whose
     * screen no longer exists.
     *
     * That is the "frozen except the Ask Hawkeye button" report. AskFab is the
     * survivor because it is mounted OUTSIDE the Stack (below, after </Stack>),
     * so it is the one control not covered by the orphan — which is why the
     * symptom names it, and why the FAB itself was never the fault.
     *
     * Intermittent by construction: it needs auth to flip to signedOut while a
     * modal happens to be open, which depends on when a token check resolves.
     *
     * dismissAll() unwinds the modal presentations first and is a no-op when
     * none are up, so the ordinary signed-out bounce is unchanged. It is
     * wrapped because it throws if the navigator has not mounted yet, and this
     * effect can run on the very first frame.
     */
    try {
      if (router.canDismiss?.()) router.dismissAll();
    } catch {
      /* nothing to dismiss, or the navigator is not ready — replace anyway */
    }
    router.replace('/welcome');
  }, [auth.status, segments]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* The palette. NativeWind turns a class-scoped custom property into a
          variable every descendant inherits, so this single className is what
          makes bg-surface / text-ink / bg-good resolve light or dark for the
          entire tree — including modal screens and sheets, which are React
          children of the Stack even when the platform presents them natively.
          Anything rendered OUTSIDE this View falls back to :root, i.e. light. */}
      <View className={themeClass(scheme)} style={{ flex: 1 }}>
        {/* Nothing themed paints until the stored preference is known, so the
            first frame is already correct rather than flashing the OS theme and
            correcting itself. The native splash is still up while we wait
            because AnimatedSplashOverlay — which is what calls
            SplashScreen.hideAsync() — is inside this gate. */}
        {/* Also wait for auth: the Stack's initial route is the tabs, so painting
            before auth resolves flashed the home screen for signed-out users
            before the welcome redirect landed. The native splash covers the wait. */}
        {!loaded || auth.status === 'loading' ? null : (
          <ThemeProvider value={dark ? DarkTheme : DefaultTheme}>
            <StatusBar style={dark ? 'light' : 'dark'} />
            <AnimatedSplashOverlay />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="sign-in" options={{ presentation: 'modal' }} />
              <Stack.Screen name="welcome" options={{ animation: 'fade' }} />
              <Stack.Screen name="report/result" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="report/incident" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="report/collation" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="map-unit" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="ledger" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="reports-log" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="integrity" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="docket" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="case" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="osun" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="candidates" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="political" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="profile" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="page" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="practice" options={{ presentation: 'modal' }} />
              <Stack.Screen name="incidents" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="terms" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="assistant" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="map" options={{ presentation: 'fullScreenModal' }} />
            </Stack>
            {/* After the Stack, so it draws over every screen and the tab bar. One
                instance for the whole app: mounted per-screen it would forget where
                it was dragged to the moment anyone navigated. */}
            <AskFab />
          </ThemeProvider>
        )}
      </View>
    </GestureHandlerRootView>
  );
}
