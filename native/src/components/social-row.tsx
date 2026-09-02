import Feather from '@expo/vector-icons/Feather';
import * as WebBrowser from 'expo-web-browser';
import { Linking, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { SectionLabel } from '@/components/content-kit';
import { shareHawkeye } from '@/lib/share';
import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';

/** Optical size for every mark in the accounts strip. One constant, so the
 *  Feather glyphs and the hand-drawn X below can never drift apart. */
const GLYPH = 20;

/**
 * X's mark is not in Feather (its `twitter` glyph is the retired bird), so it is
 * drawn from the same path the website's footer uses.
 *
 * The path is byte-identical to the one this file has always carried; only the
 * viewBox is tightened. In a 24-unit box a Feather glyph stands 20 units tall,
 * while this mark's ink spans just 16 (x and y both run 4..20) — so at an equal
 * `size` prop it rendered a fifth shorter than the icons beside it, which is
 * most of what made the old row read as a mismatched jumble. A 20.5-unit box
 * centred on (12,12) scales the mark to ~0.78 of its frame: deliberately just
 * under a Feather glyph's 0.833, because this mark is solid where the others
 * are stroked, and a solid mark at identical height reads larger.
 */
function XMark({ color, size }: { color: string; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="1.75 1.75 20.5 20.5">
      <Path
        d="M4 4l6.9 8.4L4.3 20H7l5.1-5.7L16.6 20H20l-7.2-8.8L19.4 4H16.8l-4.6 5.2L8.2 4z"
        fill={color}
      />
    </Svg>
  );
}

/**
 * Where to find Hawkeye off-app.
 *
 * This shares its ACCOUNTS with the social row menu.js builds into every page
 * footer — the same four links in the same order, and the X path below is
 * copied from that footer's — but it is deliberately no longer the same
 * component. The website footer is a bare strip of four outlined icon circles:
 * no heading, no Telegram entry, no text labels. This one has all three,
 * because a footer and a screen section are not the same job: the footer is
 * something you scroll past, while here the row is content, and on a phone an
 * unlabelled glyph is a guess. Keep the URL list in step with menu.js; do not
 * expect the two layouts to converge.
 *
 * Two tiers, because these links are not the same kind of thing:
 *
 *  - The Telegram bot is not marketing. It delivers OTP codes and result
 *    alerts, so it is the one link here an observer may actually need, and it
 *    gets the app's standard action-card shape — icon tile, what it does, a
 *    real call to action — rather than a glyph in a row of logos.
 *  - The four social accounts are secondary: one card, four equal cells,
 *    every mark at the same optical size and every cell the same weight.
 *
 * The section heading lives here too, so all three screens that show this
 * render nothing but <SocialRow /> and cannot drift apart again.
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

export function SocialRow() {
  const ui = useUi();
  return (
    <View>
      <SectionLabel text="Find Hawkeye" />

      {/* SHARE HAWKEYE, FIRST IN THE SECTION.

          The rest of this section is where to find Hawkeye; this is how someone
          else finds it, which is the only one of the five that does anything for
          an election. It takes the same action-card shape as the Telegram row
          below rather than being a sixth glyph in the accounts strip — an
          unlabelled share icon in a row of logos reads as "post to a share
          service", and this is a person sending a link to their sister.

          Gold tile against Telegram's green: two cards of identical weight, in a
          section that is otherwise muted, need something to say which one is
          being offered. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Share Hawkeye — send the app to someone"
        className="mb-2 flex-row rounded-2xl bg-card p-4 active:opacity-80"
        onPress={shareHawkeye}
      >
        <View className="h-11 w-11 items-center justify-center rounded-2xl bg-surface">
          <Feather name="share-2" size={19} color={BRAND.gold} />
        </View>
        <View className="flex-1 pl-3.5">
          <Text className="text-base font-bold text-ink">Share Hawkeye</Text>
          <Text className="pt-1 text-sm leading-5 text-muted">
            Send the app to someone who votes.
          </Text>
          <View className="flex-row items-center pt-2">
            <Text className="text-sm font-bold text-good-ink">Share the download link</Text>
            <Feather
              name="arrow-right"
              size={13}
              color={ui.tint.good.ink}
              style={{ marginLeft: 4 }}
            />
          </View>
        </View>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open Hawkeye on Telegram, @HawkEyeNGBot"
        className="flex-row rounded-2xl bg-card p-4 active:opacity-80"
        onPress={() => open(TELEGRAM_BOT)}
      >
        <View className="h-11 w-11 items-center justify-center rounded-2xl bg-surface">
          <Feather name="send" size={19} color={ui.tint.good.ink} />
        </View>
        <View className="flex-1 pl-3.5">
          <Text className="text-base font-bold text-ink">Hawkeye on Telegram</Text>
          <Text className="pt-1 text-sm leading-5 text-muted">
            Your OTP codes and result alerts arrive here.
          </Text>
          <View className="flex-row items-center pt-2">
            <Text className="text-sm font-bold text-good-ink">Open @HawkEyeNGBot</Text>
            <Feather
              name="arrow-right"
              size={13}
              color={ui.tint.good.ink}
              style={{ marginLeft: 4 }}
            />
          </View>
        </View>
      </Pressable>

      {/* The accounts, deliberately quieter than the card above: muted marks on
          one card, split into four equal cells by the same hairline the rest of
          the app divides list rows with. */}
      <View className="mt-2 flex-row overflow-hidden rounded-2xl bg-card">
        {SOCIAL.map((s, i) => (
          <Pressable
            key={s.name}
            accessibilityRole="button"
            accessibilityLabel={`Hawkeye on ${s.name}`}
            onPress={() => open(s.url)}
            className={`flex-1 items-center py-3.5 active:bg-surface ${
              i > 0 ? 'border-l border-line' : ''
            }`}
          >
            {/* Fixed-height box so an SVG mark and a Feather glyph — which is a
                text run, with a text run's line box — sit on the same line. */}
            <View className="h-6 justify-center">
              {s.icon === 'x' ? (
                <XMark color={ui.muted} size={GLYPH} />
              ) : (
                <Feather name={s.icon} size={GLYPH} color={ui.muted} />
              )}
            </View>
            {/* text-muted, not text-faint: --faint is rgb(141 156 147), which is
                2.87:1 on white. These are 11px, so they get no large-text
                allowance and 2.87:1 fails AA outright. text-muted is 7.6:1
                light / 7.7:1 dark and still reads quieter than the marks. */}
            <Text className="pt-1.5 text-[11px] font-medium text-muted">{s.name}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
