import { Feather } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { Linking, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { BRAND } from '@/lib/api';

/** X's mark is not in Feather (its `twitter` glyph is the retired bird), so it
 *  is drawn from the same path the website's footer uses. */
function XMark({ color, size = 17 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M4 4l6.9 8.4L4.3 20H7l5.1-5.7L16.6 20H20l-7.2-8.8L19.4 4H16.8l-4.6 5.2L8.2 4z"
        fill={color}
      />
    </Svg>
  );
}

/**
 * Where to find Hawkeye off-app — the native twin of the social row menu.js
 * builds into every page footer, kept in the same order and pointing at the
 * same accounts.
 *
 * The Telegram bot leads because it is not marketing: it delivers OTP codes
 * and result alerts, so it is the one link an observer may actually need. It
 * opens through Linking first so an installed Telegram app takes it, falling
 * back to the browser.
 */
export const TELEGRAM_BOT = 'https://t.me/HawkEyeNGBot';

const SOCIAL: { name: string; icon: keyof typeof Feather.glyphMap | 'x'; url: string }[] = [
  { name: 'TikTok', icon: 'music', url: 'https://www.tiktok.com/@hawkeyengbot' },
  { name: 'Instagram', icon: 'instagram', url: 'https://www.instagram.com/hawkeyengbot/' },
  { name: 'X', icon: 'x', url: 'https://x.com/HawkEyeNGBot' },
  {
    name: 'Facebook',
    icon: 'facebook',
    url: 'https://www.facebook.com/people/Hawkeye/61591831703798/',
  },
];

async function open(url: string) {
  // Deep-link into the installed app when there is one; otherwise the in-app
  // browser, which keeps the observer inside Hawkeye.
  try {
    if (await Linking.canOpenURL(url)) {
      await Linking.openURL(url);
      return;
    }
  } catch {
    /* fall through */
  }
  await WebBrowser.openBrowserAsync(url);
}

export function SocialRow({ dark }: { dark?: boolean }) {
  const border = dark ? 'border-white/25' : 'border-black/10';
  const tint = dark ? '#e8f2ec' : BRAND.leaf;
  return (
    <View className="pt-2">
      <Pressable
        className={`flex-row items-center rounded-2xl border ${border} px-4 py-3 active:opacity-70`}
        onPress={() => open(TELEGRAM_BOT)}
      >
        <Feather name="send" size={17} color={tint} />
        <View className="flex-1 pl-3">
          <Text className={`text-sm font-bold ${dark ? 'text-white' : 'text-ink'}`}>
            Hawkeye on Telegram
          </Text>
          <Text className={`text-xs ${dark ? 'text-emerald-200' : 'text-muted'}`}>
            @HawkEyeNGBot — OTP codes, result alerts
          </Text>
        </View>
        <Feather name="external-link" size={15} color={dark ? '#9db5a7' : '#9db5a7'} />
      </Pressable>

      <View className="flex-row justify-center pt-3">
        {SOCIAL.map((s) => (
          <Pressable
            key={s.name}
            accessibilityLabel={`Hawkeye on ${s.name}`}
            onPress={() => open(s.url)}
            className={`mx-1.5 h-11 w-11 items-center justify-center rounded-full border ${border} active:opacity-70`}
          >
            {s.icon === 'x' ? (
              <XMark color={tint} />
            ) : (
              <Feather name={s.icon} size={17} color={tint} />
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );
}
