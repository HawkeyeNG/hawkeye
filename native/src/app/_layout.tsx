import 'react-native-gesture-handler';
import '../global.css';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { bootstrapAuth } from '@/lib/auth';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
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
          <Stack.Screen name="report/result" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="report/incident" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="report/collation" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="map-unit" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="ledger" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="reports-log" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="practice" options={{ presentation: 'modal' }} />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
