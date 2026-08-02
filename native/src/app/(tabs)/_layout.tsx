import { Feather } from '@expo/vector-icons';
import type BottomSheet from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { router, Tabs } from 'expo-router';
import { useRef } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ReportSheet } from '@/components/report-sheet';
import { BRAND } from '@/lib/api';
import { useUnread } from '@/lib/push';
import { useUi } from '@/lib/theme';

/**
 * Tab bar sizing — the native twin of the web `.tabbar` (app/styles.css).
 *
 * The web version never states a height: the column is intrinsic (icon + gap +
 * label + padding) and the gesture-bar inset is ADDED on top via
 * `padding: 6px 4px calc(6px + env(safe-area-inset-bottom))`. The native side
 * used to hard-code `height: 62`, and react-navigation honours a numeric height
 * verbatim (see getTabBarHeight in BottomTabBar) while still applying
 * `paddingBottom: insets.bottom` underneath it — so under Android edge-to-edge
 * the gesture bar ate its inset OUT of the 62, leaving as little as 32px for a
 * 25px icon plus a label. That is why it read short next to the PWA.
 *
 * So: derive the content height from the parts, then add insets.bottom to both
 * the height and the bottom padding. The usable column is then constant at
 * every inset, exactly like the web.
 */
const ICON_SIZE = 23; // .tabbar .tab svg { width: 23px; height: 23px }
const LABEL_FONT_SIZE = 11; // .tab { font-size: 0.64rem } ≈ 10.2px, rounded up for RN
const LABEL_LINE_HEIGHT = 14;
const LABEL_GAP = 3; // .tab { gap: 3px }
/** Baked into react-navigation's `tabVerticalUiKit` item style — not ours to set. */
const ITEM_PADDING_V = 5;
const BAR_PADDING_TOP = 4; // + ITEM_PADDING_V = 9, matching the web's 6 + 3
const BAR_PADDING_BOTTOM = 6; // the constant half of the web's calc(6px + inset)

/** Intrinsic bar height before the safe-area inset is added. */
const BAR_CONTENT_HEIGHT =
  BAR_PADDING_TOP +
  ITEM_PADDING_V +
  ICON_SIZE +
  LABEL_GAP +
  LABEL_LINE_HEIGHT +
  ITEM_PADDING_V +
  BAR_PADDING_BOTTOM; // 60

/**
 * Raised centre action, mirroring `.tabbar .tab-cta .ti` (50px circle,
 * margin-top -22). Its icon slot keeps the standard 23px height so its label
 * stays on the same line as its siblings — only the circle overhangs.
 *
 * Yoga centres a child's MARGIN box, so a 48px circle with marginTop -CTA_LIFT
 * in a 23px slot resolves to a border-box top of (23 - 30) / 2 - 18 = -21.5
 * relative to the slot, and the slot itself starts BAR_PADDING_TOP +
 * ITEM_PADDING_V = 9 below the bar's top edge. Net overhang above that edge is
 * ~12px, which is what the web gets too (6 + 3 - 22 = -13). The circle's bottom
 * lands level with the top of the label's line box, same as the shipped build.
 */
const CTA_SIZE = 48;
const CTA_LIFT = 18;

/**
 * Five-tab shell — the native twin of the web app's tab bar (app/menu.js):
 * Home · Results · Report (raised CTA) · Alerts · More. Report never
 * navigates; it opens the action sheet, exactly like the web shell.
 */
export default function TabsLayout() {
  const sheetRef = useRef<BottomSheet>(null);
  /** Unread alerts, kept live by usePushNotifications() in the root layout. */
  const unread = useUnread();
  /** Gesture bar / home indicator. Added to the bar, never subtracted from it. */
  const insets = useSafeAreaInsets();
  const ui = useUi();

  /**
   * Tab tints, theme-aware — the selected tab must be the most prominent thing
   * on this bar in BOTH themes.
   *
   * It wasn't. The active tint was a fixed BRAND.green (#004225), which is our
   * deepest brand colour: 11.6:1 on the light bar, but only ~1.6:1 on the dark
   * one, where it is a near-black smudge that reads as the DISABLED tab while
   * the grey inactive ones look selected. Dark mode therefore takes the palette's
   * good-ink (#6edba0) — the same mint the rest of the app uses for a positive
   * accent — which lands at 9.5:1 on the dark bar and keeps the green identity.
   *
   * Inactive moves off the hardcoded #7c8a81 to `ui.muted`. That grey was 4.7:1
   * on dark but only 3.3:1 on the WHITE bar, i.e. the light theme was quietly
   * failing AA for these 11px labels; muted passes comfortably in both (6.6:1
   * light, 7.1:1 dark) and still sits well below the active tint.
   *
   * The bar's own background is pinned to ui.card too. Left unset it comes from
   * react-navigation's theme — a neutral rgb(18,18,18) in dark that neither
   * matches our green-tinted cards nor keeps these ratios stable if that theme
   * ever shifts underneath us.
   */
  const activeTint = ui.dark ? ui.tint.good.ink : BRAND.green;
  const inactiveTint = ui.muted;

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: activeTint,
          tabBarInactiveTintColor: inactiveTint,
          tabBarStyle: {
            backgroundColor: ui.card,
            height: BAR_CONTENT_HEIGHT + insets.bottom,
            paddingTop: BAR_PADDING_TOP,
            paddingBottom: BAR_PADDING_BOTTOM + insets.bottom,
          },
          tabBarIconStyle: { width: ICON_SIZE, height: ICON_SIZE },
          tabBarLabelStyle: {
            fontSize: LABEL_FONT_SIZE,
            lineHeight: LABEL_LINE_HEIGHT,
            fontWeight: '600',
            marginTop: LABEL_GAP,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color }) => <Feather name="home" size={ICON_SIZE} color={color} />,
          }}
        />
        <Tabs.Screen
          name="results"
          options={{
            title: 'Results',
            tabBarIcon: ({ color }) => <Feather name="bar-chart-2" size={ICON_SIZE} color={color} />,
          }}
        />
        <Tabs.Screen
          name="report"
          options={{
            title: 'Report',
            tabBarLabelStyle: {
              fontSize: LABEL_FONT_SIZE,
              lineHeight: LABEL_LINE_HEIGHT,
              fontWeight: '700',
              marginTop: LABEL_GAP,
              // Same theme-aware green as the active tab: this label sits on the
              // BAR, not on the CTA circle, so the fixed brand green made it a
              // ~1.4:1 smudge in dark mode — the least legible label of the five.
              color: activeTint,
            },
            // Wide enough for the circle to sit unclipped; still 23px tall so
            // the label lines up with the other four tabs.
            tabBarIconStyle: { width: CTA_SIZE, height: ICON_SIZE },
            tabBarIcon: () => (
              <View
                className="items-center justify-center rounded-full bg-hawk-green"
                style={{
                  width: CTA_SIZE,
                  height: CTA_SIZE,
                  marginTop: -CTA_LIFT,
                  shadowColor: '#000',
                  shadowOpacity: 0.25,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 3 },
                  elevation: 6,
                }}
              >
                <Feather name="camera" size={22} color={BRAND.gold} />
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
            tabBarBadge: unread || undefined,
            title: 'Alerts',
            tabBarIcon: ({ color }) => <Feather name="bell" size={ICON_SIZE} color={color} />,
          }}
        />
        <Tabs.Screen
          name="more"
          options={{
            title: 'More',
            tabBarIcon: ({ color }) => <Feather name="menu" size={ICON_SIZE} color={color} />,
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
          if (a === 'incident') {
            router.push('/report/incident');
            return;
          }
          router.push('/report/collation');
        }}
      />
    </View>
  );
}
