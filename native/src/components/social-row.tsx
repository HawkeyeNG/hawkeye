import Feather from '@expo/vector-icons/Feather';
import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { SectionLabel } from '@/components/content-kit';
import { shareHawkeye } from '@/lib/share';
import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';
import { t as i18nT } from '@/lib/i18n';

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
 * footer — the same five links in the same order, and the X path below is
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
 *  - The five social accounts are secondary: one card, five equal cells,
 *    every mark at the same optical size and every cell the same weight.
 *
 * The section heading lives here too, so all three screens that show this
 * render nothing but <SocialRow /> and cannot drift apart again.
 */
export const TELEGRAM_BOT = 'https://t.me/HawkEyeNGBot';

/**
 * `app` is the platform's OWN url scheme, tried before the https link.
 *
 * Handing the OS an https url only reaches the installed app when that app has
 * VERIFIED App Links (Android) / Universal Links (iOS) for the exact path —
 * which is the app publisher's decision, not ours. TikTok and X have done it,
 * so those already open natively. Instagram and LinkedIn have not, so the OS
 * hands the url to a browser; their own "open in app" banner then offers the
 * store rather than the page, because the website cannot pass the deep link
 * across. Facebook sits in between, which is where its popup comes from.
 *
 * A scheme url is not subject to any of that: it addresses the app directly.
 * TikTok keeps the https url because its scheme needs a numeric user id that a
 * @handle does not give us, and its App Links already work.
 */
const SOCIAL: {
  name: string;
  icon: keyof typeof Feather.glyphMap | 'x';
  url: string;
  app?: string;
}[] = [
  { name: 'TikTok', icon: 'music', url: 'https://www.tiktok.com/@hawkeyengbot' },
  {
    name: 'Instagram',
    icon: 'instagram',
    url: 'https://www.instagram.com/hawkeyengbot/',
    app: 'instagram://user?username=hawkeyengbot',
  },
  {
    name: 'X',
    icon: 'x',
    url: 'https://x.com/HawkEyeNGBot',
    app: 'twitter://user?screen_name=HawkEyeNGBot',
  },
  {
    name: 'Facebook',
    icon: 'facebook',
    url: 'https://www.facebook.com/people/Hawkeye/61591831703798/',
    // The page id out of the https url above; fb://page/<id> lands on the page
    // itself, which is what the "open in the app?" prompt was asking to do.
    app: 'fb://page/61591831703798',
  },
  {
    name: 'LinkedIn',
    icon: 'linkedin',
    url: 'https://www.linkedin.com/company/hawkeye-election-monitor',
    // iOS ONLY, and the asymmetry is measured, not assumed: tested on devices,
    // linkedin://company/<vanity-name> opens the Hawkeye page on iOS and dumps
    // the user on LinkedIn's HOME FEED on Android. The scheme is documented for
    // numeric company ids; iOS evidently resolves the vanity name and Android
    // does not, and a feed is worse than the website — it looks like the link
    // went to the wrong place.
    //
    // undefined on Android means open() skips straight to the https url, which
    // is the behaviour it had before schemes existed.
    app: Platform.OS === 'ios'
      ? 'linkedin://company/hawkeye-election-monitor'
      : undefined,
  },
];

async function open(url: string, app?: string) {
  // THE APP'S OWN SCHEME FIRST, when there is one.
  //
  // openURL, not canOpenURL: on iOS canOpenURL answers false for any scheme
  // not listed in LSApplicationQueriesSchemes even when the app IS installed,
  // and on Android 11+ it needs a <queries> entry — both of which would make
  // this silently fall through to the website on a phone that has the app.
  // openURL is subject to neither; it simply rejects when nothing handles the
  // url, which is the signal we want.
  if (app) {
    try {
      await Linking.openURL(app);
      return;
    } catch {
      // Not installed, or the scheme was refused. The website below is a
      // strictly better outcome than an error, and is what happened before.
    }
  }

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
      <SectionLabel text={i18nT("n.components.social-row.find-hawkeye")} />

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
        accessibilityLabel={i18nT('n.components.social-row.share-hawkeye-send-the-app-to')}
        className="mb-2 flex-row rounded-2xl bg-card p-4 active:opacity-80"
        onPress={shareHawkeye}
      >
        <View className="h-11 w-11 items-center justify-center rounded-2xl bg-surface">
          <Feather name="share-2" size={19} color={BRAND.gold} />
        </View>
        <View className="flex-1 pl-3.5">
          <Text className="text-base font-bold text-ink">{i18nT('profile.share-hawkeye')}</Text>
          <Text className="pt-1 text-sm leading-5 text-muted">
            {i18nT('n.components.social-row.send-the-app-to-someone-who')}
          </Text>
          <View className="flex-row items-center pt-2">
            <Text className="text-sm font-bold text-good-ink">{i18nT('n.components.social-row.share-the-download-link')}</Text>
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
        accessibilityLabel={i18nT('n.components.social-row.open-hawkeye-on-telegram-hawkeyengbot')}
        className="flex-row rounded-2xl bg-card p-4 active:opacity-80"
        onPress={() => open(TELEGRAM_BOT)}
      >
        <View className="h-11 w-11 items-center justify-center rounded-2xl bg-surface">
          <Feather name="send" size={19} color={ui.tint.good.ink} />
        </View>
        <View className="flex-1 pl-3.5">
          <Text className="text-base font-bold text-ink">{i18nT('n.components.social-row.hawkeye-on-telegram')}</Text>
          <Text className="pt-1 text-sm leading-5 text-muted">
            {i18nT('n.components.social-row.your-otp-codes-and-result-alerts')}
          </Text>
          <View className="flex-row items-center pt-2">
            <Text className="text-sm font-bold text-good-ink">{i18nT('n.components.social-row.open-hawkeyengbot')}</Text>
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
          one card, split into five equal cells by the same hairline the rest of
          the app divides list rows with. At five cells a 360px screen gives each
          about 64px, so the labels stay on one line — 'Instagram' at 11px is the
          longest and measures ~55px. */}
      <View className="mt-2 flex-row overflow-hidden rounded-2xl bg-card">
        {SOCIAL.map((s, i) => (
          <Pressable
            key={s.name}
            accessibilityRole="button"
            accessibilityLabel={i18nT('n.components.social-row.hawkeye-on', { v0: s.name })}
            onPress={() => open(s.url, s.app)}
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
