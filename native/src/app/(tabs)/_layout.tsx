import { Feather } from '@expo/vector-icons';
import type BottomSheet from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { router, Tabs } from 'expo-router';
import { useRef } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { ReportSheet } from '@/components/report-sheet';
import { BRAND } from '@/lib/api';

/**
 * Five-tab shell — the native twin of the web app's tab bar (app/menu.js):
 * Home · Results · Report (raised CTA) · Alerts · More. Report never
 * navigates; it opens the action sheet, exactly like the web shell.
 */
export default function TabsLayout() {
  const sheetRef = useRef<BottomSheet>(null);

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: BRAND.green,
          tabBarInactiveTintColor: '#7c8a81',
          tabBarStyle: { height: 62, paddingTop: 6 },
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600', paddingBottom: 6 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color, size }) => <Feather name="home" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="results"
          options={{
            title: 'Results',
            tabBarIcon: ({ color, size }) => <Feather name="bar-chart-2" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="report"
          options={{
            title: 'Report',
            tabBarLabelStyle: { fontSize: 11, fontWeight: '700', paddingBottom: 6, color: BRAND.green },
            tabBarIcon: () => (
              <View
                className="items-center justify-center rounded-full bg-hawk-green"
                style={{
                  width: 46,
                  height: 46,
                  marginTop: -18,
                  shadowColor: '#000',
                  shadowOpacity: 0.25,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 3 },
                  elevation: 6,
                }}
              >
                <Feather name="camera" size={20} color={BRAND.gold} />
              </View>
            ),
            tabBarButton: ({ ref: _ref, ...props }) => (
              <Pressable
                {...props}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  sheetRef.current?.expand();
                }}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="alerts"
          options={{
            title: 'Alerts',
            tabBarIcon: ({ color, size }) => <Feather name="bell" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="more"
          options={{
            title: 'More',
            tabBarIcon: ({ color, size }) => <Feather name="menu" size={size} color={color} />,
          }}
        />
      </Tabs>
      <ReportSheet
        ref={sheetRef}
        onAction={(a) => {
          sheetRef.current?.close();
          if (a === 'result') {
            router.push('/report/result');
            return;
          }
          // Incident + collation flows land next; the result flow proves the pattern.
          Alert.alert(
            'Coming to the native app',
            `The ${a} flow is being rebuilt natively. Use the current app for live reporting.`,
          );
        }}
      />
    </View>
  );
}
