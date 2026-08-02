import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';

import { useUi } from '@/lib/theme';
import { useThemePref, type ThemePref } from '@/lib/theme-pref';

import { ScreenHeader } from '@/components/screen-header';
import { SocialRow } from '@/components/social-row';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';

/**
 * More — the menu.js panel groups, carried over 1:1. Until each page is
 * rebuilt natively, entries open the live site in an in-app browser tab,
 * so nothing the web app offers is unreachable from the native shell.
 */
type Icon = keyof typeof Feather.glyphMap;
type MenuLink = { label: string; href: string; icon: Icon };
type MenuItem = MenuLink | { acc: string; icon: Icon; items: MenuLink[] };

const GROUPS: { title: string; items: MenuItem[] }[] = [
  {
    title: 'Take part',
    items: [
      { label: 'My Profile', href: 'native:/profile', icon: 'user' },
      // Report accordion — the three report flows collapsed under one entry.
      {
        acc: 'Report',
        icon: 'edit-3',
        items: [
          { label: 'Report a Result', href: 'native:/report/result', icon: 'camera' },
          { label: 'Report a Collation Result', href: 'native:/report/collation', icon: 'layers' },
          { label: 'Report an Incident', href: 'native:/report/incident', icon: 'alert-triangle' },
        ],
      },
      { label: 'Practice Run', href: 'native:/practice', icon: 'play-circle' },
      { label: 'Map a Polling Unit', href: 'native:/map-unit', icon: 'map-pin' },
    ],
  },
  {
    title: 'Trust & verify',
    items: [
      { label: 'Verify the Ledger', href: 'native:/ledger', icon: 'shield' },
      { label: 'Election Integrity', href: 'native:/integrity', icon: 'activity' },
      { label: 'Public Docket', href: 'native:/docket', icon: 'file-text' },
      { label: 'Incident Reports', href: 'native:/incidents', icon: 'alert-triangle' },
    ],
  },
  {
    title: 'Live data',
    items: [
      // The website's nav lists the Leaderboard here, so the menu does too. It
      // is also a tab, but a tab is not a list entry: someone looking for it by
      // name in the menu found nothing. "Leaderboard", not "National
      // Leaderboard" — the word matches results.html's nav and <h1>.
      { label: 'Leaderboard', href: 'native:/(tabs)/results', icon: 'bar-chart-2' },
      // Races accordion — Osun + Presidency; other race categories join as built.
      {
        acc: 'Races',
        icon: 'trending-up',
        items: [
          // All Races — the selector where every contest will live as it opens.
          { label: 'All Races', href: 'native:/races', icon: 'grid' },
          { label: 'Osun 2026', href: 'native:/osun', icon: 'trending-up' },
          { label: 'Presidency 2027', href: 'native:/candidates', icon: 'users' },
        ],
      },
      { label: 'Public Reports Log', href: 'native:/reports-log', icon: 'list' },
      { label: 'Political Data', href: 'native:/political', icon: 'pie-chart' },
    ],
  },
  {
    title: 'Learn & about',
    items: [
      { label: 'Ask Hawkeye', href: 'native:/assistant', icon: 'message-square' },
      { label: 'How Hawkeye Works', href: 'native:/page?slug=how', icon: 'help-circle' },
      { label: 'Observer Guide', href: 'native:/page?slug=guide', icon: 'book-open' },
      { label: 'FAQ', href: 'native:/page?slug=faq', icon: 'message-circle' },
      { label: 'About & Contact', href: 'native:/page?slug=about', icon: 'info' },
      { label: 'Support Hawkeye', href: 'native:/support', icon: 'heart' },
      { label: 'Privacy & Data', href: 'native:/page?slug=privacy', icon: 'lock' },
      { label: 'Terms of Service', href: 'native:/terms', icon: 'file-text' },
    ],
  },
];

/**
 * The three appearance choices, in the order every OS lists them: follow the
 * device first, then the two overrides.
 */
const THEME_OPTIONS: {
  value: ThemePref;
  label: string;
  icon: keyof typeof Feather.glyphMap;
}[] = [
  { value: 'system', label: 'System', icon: 'smartphone' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];

/**
 * Appearance — Light / Dark / System.
 *
 * Deliberately a visible segmented control rather than a row that opens a
 * sheet: the reason this exists at all is that the app followed the OS with no
 * override and the setting could not be found. One more tap to reveal it would
 * not have fixed that. It still reads as one of this screen's rows — same card,
 * same group heading, same pill shape and the same `good-ink` "this one is on"
 * treatment the open-races filter uses in contest-picker.
 */
function AppearanceGroup() {
  const ui = useUi();
  const { pref, scheme, setPref } = useThemePref();
  const current = THEME_OPTIONS.find((o) => o.value === pref) ?? THEME_OPTIONS[0];

  return (
    <View className="pb-2">
      <Text className="pb-2 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
        Appearance
      </Text>
      <View className="overflow-hidden rounded-2xl bg-card">
        <View className="flex-row items-center px-4 py-3.5">
          {/* Themed, not the fixed light green it was: on the one row whose job
              is to prove the theme flips, a hardcoded #0b6b3a sat at ~2.5:1 on
              the dark card — under the 3:1 minimum for non-text, and a visible
              smudge beside tints that had all moved. */}
          <Feather name="droplet" size={17} color={ui.tint.good.ink} />
          <Text className="flex-1 pl-3 text-base text-ink">Theme</Text>
          <Text className="text-sm text-muted">
            {/* Saying which way "System" currently lands saves anyone wondering
                whether the setting took effect at all. */}
            {current.value === 'system' ? `System · ${scheme}` : current.label}
          </Text>
        </View>
        <View className="border-t border-line p-3">
          <View className="flex-row rounded-full bg-surface p-1">
            {THEME_OPTIONS.map((o) => {
              const on = o.value === pref;
              return (
                <Pressable
                  key={o.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${o.label} theme`}
                  onPress={() => {
                    if (on) return;
                    Haptics.selectionAsync();
                    setPref(o.value);
                  }}
                  /* Selected is bg-card on a bg-surface track — the raised-on-
                     inset relationship the rest of the app uses, and the only
                     pair that separates in BOTH themes. bg-good was the first
                     choice (it is what contest-picker's active filter uses) but
                     in light mode #dff2e8 on #e8f2ec is two pale mints and the
                     selected pill vanished; the good-ink label carries that
                     signal instead. */
                  className={`flex-1 flex-row items-center justify-center rounded-full py-2 active:opacity-70 ${
                    on ? 'bg-card' : ''
                  }`}
                >
                  <Feather
                    name={o.icon}
                    size={14}
                    color={on ? ui.tint.good.ink : ui.muted}
                  />
                  <Text
                    className={`pl-1.5 text-xs font-bold ${on ? 'text-good-ink' : 'text-muted'}`}
                  >
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );
}

// A collapsible menu entry (Report, Races): a normal-looking row whose chevron
// flips and whose sub-links reveal below, indented. Default closed — the point is
// a shorter menu. Only these two groups collapse; sections stay flat.
function MenuAccordion({
  title,
  icon,
  items,
  border,
}: {
  title: string;
  icon: Icon;
  items: MenuLink[];
  border: boolean;
}) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const go = (href: string) =>
    href.startsWith('native:')
      ? router.push(href.slice(7) as never)
      : WebBrowser.openBrowserAsync(`https://hawkeye.com.ng/${href}`);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className={`flex-row items-center px-4 py-3.5 active:bg-surface ${border ? 'border-t border-line' : ''}`}
        onPress={() => {
          Haptics.selectionAsync();
          setOpen((o) => !o);
        }}
      >
        <Feather name={icon} size={17} color="#0b6b3a" />
        <Text className="flex-1 pl-3 text-base text-ink">{title}</Text>
        <Feather name={open ? 'chevron-down' : 'chevron-right'} size={16} color={ui.faint} />
      </Pressable>
      {open &&
        items.map((it) => (
          <Pressable
            key={it.href}
            className="flex-row items-center border-t border-line py-3 pl-11 pr-4 active:bg-surface"
            onPress={() => go(it.href)}
          >
            <Feather name={it.icon} size={16} color={ui.faint} />
            <Text className="flex-1 pl-3 text-[15px] text-ink">{it.label}</Text>
          </Pressable>
        ))}
    </View>
  );
}

export default function More() {
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  return (
    <View className="flex-1 bg-surface">
      {/* Tab screen: right="none" — the tab bar owns navigation, and this IS the
          menu the shared header's menu button points at. The big in-scroll
          "More" title is gone; the header carries it now. */}
      <ScreenHeader title="More" right="none" translateY={translateY} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 32 }}
      >
        {/* First group on the screen. It is the one setting in the app and the
            complaint was that nobody could find it; the four navigation groups
            below are all one scroll away either way. */}
        <AppearanceGroup />
        {GROUPS.map((g) => (
          <View key={g.title} className="pb-2">
            <Text className="pb-2 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
              {g.title}
            </Text>
            <View className="overflow-hidden rounded-2xl bg-card">
              {g.items.map((it, i) =>
                'acc' in it ? (
                  <MenuAccordion key={it.acc} title={it.acc} icon={it.icon} items={it.items} border={i > 0} />
                ) : (
                  <Pressable
                    key={it.href}
                    className={`flex-row items-center px-4 py-3.5 active:bg-surface ${
                      i > 0 ? 'border-t border-line' : ''
                    }`}
                    onPress={() =>
                      it.href.startsWith('native:')
                        ? router.push(it.href.slice(7) as never)
                        : WebBrowser.openBrowserAsync(`https://hawkeye.com.ng/${it.href}`)
                    }
                  >
                    <Feather name={it.icon} size={17} color="#0b6b3a" />
                    <Text className="flex-1 pl-3 text-base text-ink">{it.label}</Text>
                    <Feather name="chevron-right" size={16} color={ui.faint} />
                  </Pressable>
                ),
              )}
            </View>
          </View>
        ))}
        {/* Heading included — SocialRow owns the whole "Find Hawkeye" section. */}
        <SocialRow />
        <Text className="pt-5 text-center text-xs text-faint">
          © IniXien, LLC · Hawkeye is independent. It does not declare results; all
          official results are announced by INEC.
        </Text>
      </Animated.ScrollView>
    </View>
  );
}
