import { Feather } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * More — the menu.js panel groups, carried over 1:1. Until each page is
 * rebuilt natively, entries open the live site in an in-app browser tab,
 * so nothing the web app offers is unreachable from the native shell.
 */
const GROUPS: { title: string; items: { label: string; href: string; icon: keyof typeof Feather.glyphMap }[] }[] = [
  {
    title: 'Take part',
    items: [
      { label: 'Practice Run', href: 'practice.html', icon: 'play-circle' },
      { label: 'Map a Polling Unit', href: 'map-unit.html', icon: 'map-pin' },
    ],
  },
  {
    title: 'Trust & verify',
    items: [
      { label: 'Verify the Ledger', href: 'ledger.html', icon: 'shield' },
      { label: 'Election Integrity', href: 'integrity.html', icon: 'activity' },
      { label: 'Public Docket', href: 'docket.html', icon: 'file-text' },
    ],
  },
  {
    title: 'Live data',
    items: [
      { label: 'Osun 2026', href: 'osun.html', icon: 'trending-up' },
      { label: 'Public Reports Log', href: 'dashboard.html', icon: 'list' },
      { label: '2027 Candidates', href: 'candidates.html', icon: 'users' },
      { label: 'Political Data', href: 'political.html', icon: 'pie-chart' },
    ],
  },
  {
    title: 'Learn & about',
    items: [
      { label: 'How Hawkeye Works', href: 'how.html', icon: 'help-circle' },
      { label: 'Observer Guide', href: 'guide.html', icon: 'book-open' },
      { label: 'FAQ', href: 'faq.html', icon: 'message-circle' },
      { label: 'About & Contact', href: 'about.html', icon: 'info' },
      { label: 'Privacy & Data', href: 'privacy.html', icon: 'lock' },
    ],
  },
];

export default function More() {
  return (
    <SafeAreaView className="flex-1 bg-hawk-mist" edges={['top']}>
      <ScrollView contentContainerClassName="px-4 pb-8">
        <Text className="pb-2 pt-4 text-2xl font-bold text-hawk-ink">More</Text>
        {GROUPS.map((g) => (
          <View key={g.title} className="pb-2">
            <Text className="pb-2 pt-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">
              {g.title}
            </Text>
            <View className="overflow-hidden rounded-2xl bg-white">
              {g.items.map((it, i) => (
                <Pressable
                  key={it.href}
                  className={`flex-row items-center px-4 py-3.5 active:bg-hawk-mist ${
                    i > 0 ? 'border-t border-hawk-mist' : ''
                  }`}
                  onPress={() =>
                    WebBrowser.openBrowserAsync(`https://hawkeye.com.ng/${it.href}`)
                  }
                >
                  <Feather name={it.icon} size={17} color="#0b6b3a" />
                  <Text className="flex-1 pl-3 text-base text-hawk-ink">{it.label}</Text>
                  <Feather name="chevron-right" size={16} color="#9db5a7" />
                </Pressable>
              ))}
            </View>
          </View>
        ))}
        <Text className="pt-4 text-center text-xs text-neutral-400">
          © IniXien, LLC · Hawkeye is independent. It does not declare results; all
          official results are announced by INEC.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
