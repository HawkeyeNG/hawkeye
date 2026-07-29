import 'react-native-gesture-handler';
import '../global.css';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { bootstrapAuth } from '@/lib/auth';
import { usePushNotifications } from '@/lib/push';

SplashScreen.preventAutoHideAsync();

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
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
