import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUi } from '@/lib/theme';

const POINTS: { icon: keyof typeof Feather.glyphMap; text: string }[] = [
  { icon: 'camera', text: 'Photograph the result sheet where it was announced' },
  { icon: 'shield', text: 'Signed on your phone, chained on a public ledger' },
  { icon: 'users', text: 'Verified when independent observers agree' },
];

/**
 * Welcome — where sign-out lands and where a fresh install can start.
 *
 * Both buttons land on the same screen, which now opens on the step that door
 * implies: "Become an observer" starts sign-up (?intent=signup — number, code,
 * then choose a password), "Sign in" starts on phone + password. A phone number
 * is still the identity, so either route ends at the same observer row.
 */
export default function Welcome() {
  const auth = useAuth();
  // Only for restoring the status-bar style on the way out — this screen is
  // fixed brand green and does not otherwise follow the theme.
  const { dark } = useUi();
  /**
   * A signed-in session must never sit on the door: resuming into welcome would
   * otherwise offer sign-in again, forever.
   *
   * ONLY WHILE THIS SCREEN IS THE ONE ON SCREEN. As a plain effect this fired
   * from UNDERNEATH the sign-in screen, which is pushed on top and leaves
   * welcome mounted. The moment an OTP verified, `auth.status` flipped here too,
   * this replace() ran, and the whole stack — including the sign-in screen that
   * was about to show the create-a-password step — was torn down. Sign-up
   * therefore ended at the code screen and dropped the new observer straight
   * into the app with no password, which is an account whose only way back in is
   * another one-time code.
   *
   * The bug was invisible in sign-in.tsx, where every branch reads correctly;
   * the navigation was being done by a screen nobody was looking at. useFocusEffect
   * scopes it to "welcome is what the user is on", which is the only case the
   * redirect was ever meant for.
   */
  useFocusEffect(
    useCallback(() => {
      if (auth.status === 'signedIn') router.replace('/(tabs)');
    }, [auth.status]),
  );

  /**
   * LIGHT STATUS-BAR ICONS ONLY WHILE THIS SCREEN IS THE ONE ON SCREEN.
   *
   * This used to be a plain `<StatusBar style="light" />` in the tree below, and
   * that made the clock and battery invisible across the whole app in light
   * mode. expo-status-bar is IMPERATIVE: mounting sets the style globally, and
   * unmounting does not put it back. So welcome set light-on-dark icons, the
   * user signed in, and the root layout's `<StatusBar style={dark ? 'light' :
   * 'dark'} />` never re-ran — its props had not changed — leaving white icons
   * on the white light-mode background for the rest of the session.
   *
   * Scoping to focus restores the theme's own style on the way out, which is
   * the same rule the Capacitor shell follows in app/native.js: pick the style
   * from the theme, and re-apply it whenever the theme changes.
   */
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle('light');
      return () => setStatusBarStyle(dark ? 'light' : 'dark');
    }, [dark]),
  );

  return (
    <SafeAreaView className="flex-1 bg-hawk-green">
      {/* Brand-green fills the screen — the clock and battery need light icons.
          Scoped to FOCUS, not to render: see the effect above for why a plain
          <StatusBar style="light" /> here made the icons vanish app-wide. */}
      {/* The whole screen is the fixed brand green, so every scrim on it is
          fixed white at low alpha — bg-card/10 followed the theme and turned
          into a dark plate on dark green. */}
      <View className="flex-1 items-center justify-center px-8">
        <View className="h-24 w-24 items-center justify-center overflow-hidden rounded-3xl bg-white/10">
          <Image source={require('../../assets/images/icon.png')} style={{ width: 96, height: 96 }} />
        </View>
        <Text className="pt-5 text-3xl font-bold tracking-widest text-white">HAWKEYE</Text>
        <Text className="pt-1 text-sm font-semibold text-emerald-200">
          Independent Election Results Monitor
        </Text>

        <View className="w-full pt-8">
          {POINTS.map((p) => (
            <View key={p.icon} className="flex-row items-center py-2.5">
              <View className="h-9 w-9 items-center justify-center rounded-full bg-white/10">
                <Feather name={p.icon} size={16} color={BRAND.gold} />
              </View>
              <Text className="flex-1 pl-3 text-sm text-emerald-50">{p.text}</Text>
            </View>
          ))}
        </View>
      </View>

      <View className="px-6 pb-6">
        <Pressable
          className="items-center rounded-2xl bg-hawk-gold py-4 active:opacity-80"
          onPress={() => router.push('/sign-in?intent=signup')}
        >
          {/* text-hawk-ink, not text-ink: the gold is fixed, so a label that
              flips near-white with the theme disappears into it (1.6:1). */}
          <Text className="text-base font-bold text-hawk-ink">Become an observer</Text>
        </Pressable>
        <Pressable
          className="mt-3 items-center rounded-2xl border border-white/30 py-4 active:opacity-70"
          onPress={() => router.push('/sign-in')}
        >
          <Text className="text-base font-bold text-white">Sign in</Text>
        </Pressable>
        <Text className="pt-4 text-center text-[11px] leading-4 text-emerald-200/70">
          Hawkeye is independent and nonpartisan. It does not declare results — all official
          results are announced by INEC.{'\n'}© 2026 IniXien, LLC. All rights reserved.
        </Text>
      </View>
    </SafeAreaView>
  );
}
