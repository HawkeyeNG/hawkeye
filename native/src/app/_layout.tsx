import 'react-native-gesture-handler';
import '../global.css';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { Pressable, ScrollView, Text, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AskFab } from '@/components/ask-fab';
import { bootstrapAuth } from '@/lib/auth';
import { usePushNotifications } from '@/lib/push';

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

export default function RootLayout() {
  const colorScheme = useColorScheme();
  // Registers the device once signed in, routes a notification tap to the screen
  // it is about, and keeps the unread badge honest. One place, so nothing
  // double-registers.
  usePushNotifications();
  useEffect(() => {
    bootstrapAuth();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
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
    </GestureHandlerRootView>
  );
}
