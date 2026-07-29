import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const POINTS: { icon: keyof typeof Feather.glyphMap; text: string }[] = [
  { icon: 'camera', text: 'Photograph the result sheet where it was announced' },
  { icon: 'shield', text: 'Signed on your phone, chained on a public ledger' },
  { icon: 'users', text: 'Verified when independent observers agree' },
];

/**
 * Welcome — where sign-out lands and where a fresh install can start.
 *
 * One flow covers both "create account" and "sign in": a phone number IS the
 * identity, so the same OTP verifies a first-timer and a returner. The two
 * buttons exist because arrivals look for their own door — they just share it.
 */
export default function Welcome() {
  const auth = useAuth();
  // A signed-in session must never sit on the door: resuming into welcome (or
  // signing in from it) would otherwise offer sign-in again, forever.
  useEffect(() => {
    if (auth.status === 'signedIn') router.replace('/(tabs)');
  }, [auth.status]);

  return (
    <SafeAreaView className="flex-1 bg-hawk-green">
      {/* Brand-green fills the screen — the clock and battery need light icons. */}
      <StatusBar style="light" />
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
          onPress={() => router.push('/sign-in')}
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
        <Pressable
          className="mt-3 items-center py-2"
          onPress={() => router.replace('/(tabs)')}
        >
          <Text className="text-sm font-semibold text-emerald-200">Explore without signing in</Text>
        </Pressable>
        <Text className="pt-4 text-center text-[11px] leading-4 text-emerald-200/70">
          Hawkeye is independent and nonpartisan. It does not declare results — all official
          results are announced by INEC.{'\n'}© 2026 IniXien, LLC. All rights reserved.
        </Text>
      </View>
    </SafeAreaView>
  );
}
